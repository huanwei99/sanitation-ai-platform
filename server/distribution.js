// distribution.js — DR-T04 发放链 chain API
// 状态机严格照 SUBSYSTEM-A §5:待审批 →已批准(审批) → 发放中(step1) → 发放中(step2) → 发放中(step3) → 已完成(step4)
// 全程写 chain_event 哈希链;出库在 step1 事务内扣减库存;审批强制前置;幂等键防重放。

const crypto = require('node:crypto');
const { recordEvent, verifyChain } = require('./chain');

// 哈希链写入/校验统一走 chain.js(单一实现)

// ---------- 哈希链(复用 foundation/engine.js 算法,保持一致) ----------
// (实现已下沉到 chain.js;此处分发逻辑直接调用 recordEvent/verifyChain)

// ---------- 幂等 ----------
// 读取幂等键;命中则返回 { hit: true, status, body }
function readIdempotency(db, key, endpoint, employeeId) {
  if (!key) return null;
  const row = db.prepare(
    'SELECT result_code, result_body FROM idempotency_keys WHERE key = ? AND endpoint = ? AND employee_id = ?'
  ).get(key, endpoint, employeeId);
  if (!row) return null;
  return { hit: true, status: row.result_code, body: JSON.parse(row.result_body || '{}') };
}
function writeIdempotency(db, key, endpoint, employeeId, status, body) {
  if (!key) return;
  db.prepare(
    'INSERT INTO idempotency_keys (key, endpoint, employee_id, result_code, result_body) VALUES (?,?,?,?,?)'
  ).run(key, endpoint, employeeId, status, JSON.stringify(body));
}

// ---------- 策略(P0-T02:统一走 org-policy 服务,改动即时生效) ----------
const { getPolicy } = require('./org-policy');
function policy(db, key, def = 'false') {
  return getPolicy(db, key, def);
}

// ---------- 权限检查(简化:仅用于本次 DR-T04,非完整 RBAC) ----------
// 库管员/仓管员可创建/发放;审批人需在审批白名单或 admin_level >= 1;一线员工仅本人签收。
function canDistribute(db, employeeId) {
  const p = db.prepare('SELECT level, scope, modules, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  if (p.admin_level >= 1) return true;
  const mods = JSON.parse(p.modules || '{}');
  if (mods.distribution && (mods.distribution.includes('edit') || mods.distribution.includes('ALL'))) return true;
  if (mods.inventory && (mods.inventory.includes('edit') || mods.inventory.includes('ALL'))) return true;
  return false;
}

// 审批权:admin_level >= 1,或发放模块带 approve/ALL(A-2:此前审批路由无任何权限校验)
function canApprove(db, employeeId) {
  const p = db.prepare('SELECT level, modules, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  if (p.admin_level >= 1) return true;
  let mods = {};
  try { mods = JSON.parse(p.modules || '{}'); } catch { mods = {}; }
  const d = mods.distribution;
  return Array.isArray(d) && (d.includes('approve') || d.includes('ALL'));
}

// 单据可见性:申请人本人 / 接收人池中 / 有发放操作权(B-2:链查询此前对任何登录人开放)
function canViewDistribution(db, employeeId, distId) {
  if (canDistribute(db, employeeId)) return true;
  const d = db.prepare('SELECT applicant_id FROM distribution WHERE id = ?').get(distId);
  if (d && d.applicant_id === employeeId) return true;
  return !!db.prepare(
    'SELECT 1 FROM distribution_recipient WHERE distribution_id = ? AND employee_id = ?'
  ).get(distId, employeeId);
}

// 携带状态码的 API 错误(事务内抛出,外层统一转成 HTTP 响应)
class ApiError extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error : 'api_error');
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------- 创建发放单 POST /distribution/requests ----------
async function createDistribution(app, req, reply) {
  const body = req.body || {};
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/requests', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canDistribute(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无创建发放单权限' });
  }
  const {
    applicant_id, department, scope = 'all', scope_desc = null,
    total_people, items, depot_id = 'DP-001', recipients = null
  } = body;
  if (!applicant_id || !total_people || !Array.isArray(items) || items.length === 0) {
    return reply.code(400).send({ ok: false, error: '需要 applicant_id/total_people/items' });
  }
  if (total_people < 1) {
    return reply.code(400).send({ ok: false, error: 'total_people 必须 >= 1' });
  }

  // 生成单号 MD-{year}-{seq}
  // C-1:用 MAX(序号)+1 而非 COUNT(*)+1 —— COUNT 不含已删/回滚记录,会撞号
  const year = new Date().getFullYear();
  const prefix = `MD-${year}-`;
  const maxRow = app.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) AS m
       FROM distribution WHERE id LIKE ?`
  ).get(prefix.length + 1, `${prefix}%`);
  const seq = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
  const distId = `${prefix}${String(seq).padStart(4, '0')}`;

  // 计算总金额
  let total_cost = 0;
  const lines = items.map((it, idx) => {
    const { item_id, per_person_qty } = it;
    if (!item_id || !per_person_qty || per_person_qty < 1) {
      throw new Error(`第 ${idx + 1} 行 item_id/per_person_qty 非法`);
    }
    const inv = app.db.prepare('SELECT unit_cost, stock FROM inventory_item WHERE id = ? AND depot_id = ?').get(item_id, depot_id);
    if (!inv) throw new Error(`物资 ${item_id} 不在仓库 ${depot_id}`);
    const qty = per_person_qty * total_people;
    total_cost += qty * inv.unit_cost;
    return { line_no: idx + 1, item_id, per_person_qty, qty };
  });

  // 落库(事务)
  app.db.transaction(() => {
    app.db.prepare(
      `INSERT INTO distribution (id, applicant_id, department, scope, scope_desc, total_people,
                                  total_cost, distributor_id, depot_id, status, current_step, total_steps)
       VALUES (?,?,?,?,?,?,?,?,?, '待审批', 0, 4)`
    ).run(distId, applicant_id, department || null, scope, scope_desc, total_people,
          total_cost, req.principal.employee_id, depot_id);

    for (const ln of lines) {
      app.db.prepare(
        `INSERT INTO distribution_line (distribution_id, line_no, item_id, per_person_qty, qty)
         VALUES (?,?,?,?,?)`
      ).run(distId, ln.line_no, ln.item_id, ln.per_person_qty, ln.qty);
    }

    // 接收人(可选,班组长去重后的池)
    if (Array.isArray(recipients)) {
      for (const r of recipients) {
        app.db.prepare(
          `INSERT OR IGNORE INTO distribution_recipient (distribution_id, employee_id, units, people_count, status)
           VALUES (?,?,?,?, '待接收')`
        ).run(distId, r.employee_id, r.units || null, r.people_count || null);
      }
    }

    // 链上写创建事件(step 0)
    recordEvent(app.db, {
      ref_type: 'distribution', ref_id: distId, step_no: 0,
      event: 'step_started',
      actor_id: req.principal.employee_id,
      actor_role: '库管员',
      payload: { action: 'create', total_people, total_cost, items }
    });
  })();

  // 写幂等
  const result = { ok: true, id: distId, status: '待审批', total_cost, lines: lines.length };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/requests',
                   req.principal.employee_id, 201, result);
  return reply.code(201).send(result);
}

// ---------- 审批 POST /distribution/:id/approve ----------
async function approveDistribution(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/approve', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const dist = app.db.prepare('SELECT * FROM distribution WHERE id = ?').get(id);
  if (!dist) return reply.code(404).send({ ok: false, error: `发放单 ${id} 不存在` });
  if (dist.status !== '待审批') {
    return reply.code(400).send({ ok: false, error: `当前状态 ${dist.status},不能审批(应待审批)` });
  }

  // 审批人不能是发放人(简单防自审)
  if (dist.distributor_id === req.principal.employee_id) {
    return reply.code(403).send({ ok: false, error: '审批人不能与发放人相同' });
  }
  // A-2:审批权校验 —— admin_level>=1 或发放模块带 approve/ALL
  if (!canApprove(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无审批权限(需 admin_level>=1 或发放审批权)' });
  }

  const approvalId = `APR-${Date.now()}`;
  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE distribution SET status = '已批准', current_step = 1, approval_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(approvalId, id);
    recordEvent(app.db, {
      ref_type: 'distribution', ref_id: id, step_no: 1,
      event: 'approval_granted',
      actor_id: req.principal.employee_id,
      actor_role: '审批人',
      payload: { approval_id: approvalId }
    });
  })();

  const result = { ok: true, id, status: '已批准', approval_id: approvalId };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/approve',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 出库(发放第一步) POST /distribution/:id/issue ----------
// 在同一事务内:扣减 inventory_item.stock、写 stock_movement、更新状态 → 发放中(step1 完成)、写 stock_deducted
async function issueDistribution(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/issue', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canDistribute(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无出库权限' });
  }

  const dist = app.db.prepare('SELECT * FROM distribution WHERE id = ?').get(id);
  if (!dist) return reply.code(404).send({ ok: false, error: `发放单 ${id} 不存在` });

  // 审批强制前置
  if (policy(app.db, 'distribution.require_approval', 'true') === 'true' && dist.status !== '已批准') {
    return reply.code(400).send({ ok: false, error: `未审批完成(当前 ${dist.status}),不能出库` });
  }
  if (dist.status !== '已批准' && dist.status !== '发放中') {
    return reply.code(400).send({ ok: false, error: `状态 ${dist.status} 不允许出库` });
  }

  const lines = app.db.prepare('SELECT * FROM distribution_line WHERE distribution_id = ? ORDER BY line_no').all(id);

  // A-4:库存校验整体在事务内 —— 保证 409 的 available 读数与扣减在同一快照,
  // 事务外预检通过后库存被改动时,事务内 UPDATE 不满足会回滚并仍回 409。
  try {
    app.db.transaction(() => {
      for (const ln of lines) {
        const inv = app.db.prepare('SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?').get(ln.item_id, dist.depot_id);
        if (!inv) throw new ApiError(404, { ok: false, error: `物资 ${ln.item_id} 不在仓库 ${dist.depot_id}` });
        if (inv.stock < ln.qty) {
          throw new ApiError(409, {
            ok: false, error: `物资 ${ln.item_id} 库存不足`,
            item_id: ln.item_id, available: inv.stock, requested: ln.qty,
          });
        }
        const updated = app.db.prepare(
          `UPDATE inventory_item SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND depot_id = ? AND stock >= ?`
        ).run(ln.qty, ln.item_id, dist.depot_id, ln.qty);
        if (updated.changes === 0) {
          const cur = app.db.prepare('SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?').get(ln.item_id, dist.depot_id);
          throw new ApiError(409, {
            ok: false, error: `物资 ${ln.item_id} 库存不足`,
            item_id: ln.item_id, available: cur ? cur.stock : 0, requested: ln.qty,
          });
        }

        const item = app.db.prepare('SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?').get(ln.item_id, dist.depot_id);
        app.db.prepare(
          `INSERT INTO stock_movement (item_id, delta, reason, ref_type, ref_id, line_no, qty_after, actor_id, depot_id)
           VALUES (?, ?, 'distribution_out', 'distribution', ?, ?, ?, ?, ?)`
        ).run(ln.item_id, -ln.qty, id, ln.line_no, item.stock, req.principal.employee_id, dist.depot_id);
      }

      // 状态推进:已批准 → 发放中(step1)
      const newStatus = '发放中';
      app.db.prepare(
        `UPDATE distribution SET status = ?, current_step = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(newStatus, id);

      // 工作流步骤(step1 = 出库)
      app.db.prepare(
        `INSERT OR REPLACE INTO workflow_step (ref_type, ref_id, step_no, name, assignee_id, status, started_at, completed_at)
         VALUES ('distribution', ?, 1, '出库', ?, '已完成', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(id, req.principal.employee_id);

      recordEvent(app.db, {
        ref_type: 'distribution', ref_id: id, step_no: 1,
        event: 'stock_deducted',
        actor_id: req.principal.employee_id,
        actor_role: '库管员',
        payload: { lines: lines.map(l => ({ item_id: l.item_id, qty: l.qty })) }
      });
    })();
  } catch (e) {
    if (e instanceof ApiError) return reply.code(e.status).send(e.body);
    return reply.code(400).send({ ok: false, error: e.message });
  }

  const result = { ok: true, id, status: '发放中', step: 1, deducted: lines.length };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/issue',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 进度推进(步骤 2/3/4) POST /distribution/:id/advance ----------
async function advanceStep(app, req, reply) {
  const { id } = req.params;
  const { step } = req.body || {};
  if (!step || step < 2 || step > 4) {
    return reply.code(400).send({ ok: false, error: 'step 必须在 2..4' });
  }
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/advance', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const dist = app.db.prepare('SELECT * FROM distribution WHERE id = ?').get(id);
  if (!dist) return reply.code(404).send({ ok: false, error: `发放单 ${id} 不存在` });
  if (dist.status !== '发放中') {
    return reply.code(400).send({ ok: false, error: `状态 ${dist.status} 不允许推进(应发放中)` });
  }
  if (step !== dist.current_step + 1) {
    return reply.code(400).send({ ok: false, error: `步骤错序(当前 ${dist.current_step},请求 ${step})` });
  }

  app.db.transaction(() => {
    const stepNames = { 2: '班组移交', 3: '员工签收', 4: '台账确认' };
    app.db.prepare(
      `INSERT OR REPLACE INTO workflow_step (ref_type, ref_id, step_no, name, assignee_id, status, completed_at)
       VALUES ('distribution', ?, ?, ?, ?, '已完成', CURRENT_TIMESTAMP)`
    ).run(id, step, stepNames[step], req.principal.employee_id);

    const isDone = step === 4;
    const newStatus = isDone ? '已完成' : '发放中';
    app.db.prepare(
      `UPDATE distribution SET current_step = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(step, newStatus, id);

    recordEvent(app.db, {
      ref_type: 'distribution', ref_id: id, step_no: step,
      event: 'step_completed',
      actor_id: req.principal.employee_id,
      actor_role: '库管员',
      payload: { step, name: stepNames[step] }
    });
  })();

  const result = { ok: true, id, step, status: step === 4 ? '已完成' : '发放中' };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/advance',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 班组移交 POST /distribution/:id/transfer ----------
async function transferDistribution(app, req, reply) {
  const { id } = req.params;
  const { recipient_id } = req.body || {};
  if (!recipient_id) return reply.code(400).send({ ok: false, error: '需要 recipient_id' });

  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/transfer', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const dist = app.db.prepare('SELECT * FROM distribution WHERE id = ?').get(id);
  if (!dist) return reply.code(404).send({ ok: false, error: `发放单 ${id} 不存在` });
  if (dist.status !== '发放中') {
    return reply.code(400).send({ ok: false, error: `状态 ${dist.status} 不允许移交(应发放中)` });
  }
  const rec = app.db.prepare(
    `SELECT * FROM distribution_recipient WHERE distribution_id = ? AND employee_id = ?`
  ).get(id, recipient_id);
  if (!rec) return reply.code(404).send({ ok: false, error: `接收人 ${recipient_id} 不在该单据` });
  if (rec.status !== '待接收') {
    return reply.code(400).send({ ok: false, error: `接收人状态 ${rec.status},不能移交` });
  }

  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE distribution_recipient SET status = '已移交', transferred_at = CURRENT_TIMESTAMP
       WHERE distribution_id = ? AND employee_id = ?`
    ).run(id, recipient_id);
    recordEvent(app.db, {
      ref_type: 'distribution', ref_id: id, step_no: 2,
      event: 'transfer',
      actor_id: req.principal.employee_id,
      actor_role: '库管员',
      payload: { recipient_id }
    });
  })();

  const result = { ok: true, id, recipient_id, status: '已移交' };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/transfer',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 签收 POST /distribution/:id/receive ----------
// 代签模型:接收人本人签收 OR 白名单岗位(班组长/车队长/队长)代签。
// body.recipient_id 指定被代签的接收人;缺省则本人签收。
async function receiveDistribution(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/receive', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const dist = app.db.prepare('SELECT * FROM distribution WHERE id = ?').get(id);
  if (!dist) return reply.code(404).send({ ok: false, error: `发放单 ${id} 不存在` });
  if (dist.status !== '发放中') {
    return reply.code(400).send({ ok: false, error: `状态 ${dist.status} 不允许签收(应发放中)` });
  }

  // 代签模型:接收人本人签收 OR 白名单岗位(班组长/车队长/队长)代签。
  // body.recipient_id 指定被代签的接收人;缺省则本人签收。
  const actorId = req.principal.employee_id;
  const targetId = Number(req.body?.recipient_id) || actorId;

  const rec = app.db.prepare(
    `SELECT * FROM distribution_recipient WHERE distribution_id = ? AND employee_id = ?`
  ).get(id, targetId);
  if (!rec) {
    return reply.code(403).send({
      ok: false, error: '接收人不在该单据接收人池'
    });
  }
  if (rec.status === '已接收') {
    return reply.code(400).send({ ok: false, error: '已签收过' });
  }
  if (rec.status !== '已移交') {
    return reply.code(400).send({ ok: false, error: '需先完成班组移交' });
  }

  // 权限判定:本人签收 OR 代签白名单(position 匹配 signoff.proxy_positions)
  let mode = 'self';
  if (targetId !== actorId) {
    const proxyPositions = getPolicy(app.db, 'signoff.proxy_positions', '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const pos = req.principal.position || '';
    const whitelisted = proxyPositions.some(kw => pos.includes(kw));
    if (!whitelisted) {
      return reply.code(403).send({
        ok: false, error: '非接收人本人,且岗位不在代签白名单'
      });
    }
    mode = 'proxy';
  }

  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE distribution_recipient SET status = '已接收', received_at = CURRENT_TIMESTAMP
       WHERE distribution_id = ? AND employee_id = ?`
    ).run(id, targetId);
    recordEvent(app.db, {
      ref_type: 'distribution', ref_id: id, step_no: 3,
      event: 'signoff',
      actor_id: actorId,
      actor_role: req.principal.position || '一线员工',
      payload: { received_by: targetId, signed_by: actorId, mode }
    });
  })();

  const result = { ok: true, id, received_by: targetId, signed_by: actorId, mode, status: '发放中' };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /distribution/:id/receive',
                   actorId, 200, result);
  return reply.send(result);
}

// ---------- 我的待签收 GET /distribution/my/pending ----------
// 返回当前登录人作为接收人、状态"已移交"(待本人签收)的单据列表
async function myPending(app, req, reply) {
  const me = req.principal.employee_id;
  const rows = app.db.prepare(
    `SELECT r.distribution_id AS id, d.status AS dist_status, d.total_people,
            d.current_step, d.depot_id, r.units, r.people_count, r.status AS recipient_status
     FROM distribution_recipient r
     JOIN distribution d ON d.id = r.distribution_id
     WHERE r.employee_id = ? AND r.status = '已移交'
     ORDER BY r.id DESC`
  ).all(me);
  return reply.send({ ok: true, items: rows });
}

// ---------- 哈希链校验 GET /distribution/:id/chain ----------
// 委托 chain.js 的 verifyChain(单一实现)
function verifyDistributionChain(db, refId) {
  return verifyChain(db, 'distribution', refId);
}

// ---------- 注册路由 ----------
async function registerDistributionRoutes(app) {
  if (!app.db) {
    app.log.warn('[distribution] db 不可用,跳过 distribution 路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    app.log.error('[distribution] 需先注册 auth 路由(authenticate 装饰器)');
    throw new Error('distribution 路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  app.post('/distribution/requests', preAuth, async (req, reply) => createDistribution(app, req, reply));
  app.get('/distribution/my/pending', preAuth, async (req, reply) => myPending(app, req, reply));
  app.post('/distribution/:id/approve', preAuth, async (req, reply) => approveDistribution(app, req, reply));
  app.post('/distribution/:id/issue', preAuth, async (req, reply) => issueDistribution(app, req, reply));
  app.post('/distribution/:id/advance', preAuth, async (req, reply) => advanceStep(app, req, reply));
  app.post('/distribution/:id/transfer', preAuth, async (req, reply) => transferDistribution(app, req, reply));
  app.post('/distribution/:id/receive', preAuth, async (req, reply) => receiveDistribution(app, req, reply));
  app.get('/distribution/:id/chain', preAuth, async (req, reply) => {
    // B-2:链查询限权 —— 申请人本人 / 接收人池中 / 有发放操作权,否则 403
    if (!canViewDistribution(app.db, req.principal.employee_id, req.params.id)) {
      return reply.code(403).send({ ok: false, error: '无权查看该单据审计链' });
    }
    const v = verifyDistributionChain(app.db, req.params.id);
    return reply.send({ ok: true, id: req.params.id, ...v });
  });
}

module.exports = {
  registerDistributionRoutes, recordEvent, verifyDistributionChain,
  readIdempotency, writeIdempotency, canDistribute, canApprove,
  canViewDistribution, ApiError
};
