// requisition.js — P1-T01 领取(物料领取)完整链 API
// 2步流程:审批中 →(approve)→ 已批准 →(step1 出库扣库存)→ 发放中 →(step2 领取人签收)→ 已完成(+已驳回)
// 服务端算 qty(直接 qty,无 per_person)、按仓校验隔离(A-T13)、审批强制前置(G3)、幂等、哈希链。
//
// 路由:
//   GET  /requisition                列表(分页+筛选+可见性)
//   GET  /requisition/:id            详情(含 lines + steps)
//   POST /requisition/requests       创建(审批中)
//   POST /requisition/:id/approve    审批通过(审批中→已批准,step1 进行中)
//   POST /requisition/:id/reject     驳回(审批中→已驳回)
//   POST /requisition/:id/issue      step1 出库(扣库存+流水,→发放中)
//   POST /requisition/:id/receive    step2 领取人签收(→已完成)
//   GET  /requisition/:id/chain      哈希链校验

const { recordEvent, verifyChain } = require('./chain');
const { getPolicy } = require('./org-policy');
const { readIdempotency, writeIdempotency, ApiError } = require('./distribution');

// ---------- 权限 ----------
// 领取操作权:admin_level>=1 或 modules.requisition/inventory 带 edit/ALL
function canRequisition(db, employeeId) {
  const p = db.prepare('SELECT level, scope, modules, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  if (p.admin_level >= 1) return true;
  const mods = JSON.parse(p.modules || '{}');
  if (mods.requisition && (mods.requisition.includes('edit') || mods.requisition.includes('ALL'))) return true;
  if (mods.inventory && (mods.inventory.includes('edit') || mods.inventory.includes('ALL'))) return true;
  return false;
}

// 审批权:admin_level>=1 或 modules.requisition 带 approve/ALL
function canApproveRequisition(db, employeeId) {
  const p = db.prepare('SELECT level, modules, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  if (p.admin_level >= 1) return true;
  let mods = {};
  try { mods = JSON.parse(p.modules || '{}'); } catch { mods = {}; }
  const r = mods.requisition;
  return Array.isArray(r) && (r.includes('approve') || r.includes('ALL'));
}

// 单据可见性:申请人本人 / 有领取操作权
function canViewRequisition(db, employeeId, reqId) {
  if (canRequisition(db, employeeId)) return true;
  const r = db.prepare('SELECT applicant_id, approver_id FROM requisition WHERE id = ?').get(reqId);
  if (!r) return false;
  return r.applicant_id === employeeId || r.approver_id === employeeId;
}

// ---------- 单号 MR-{year}-{seq} ----------
function nextReqId(db) {
  const year = new Date().getFullYear();
  const prefix = `MR-${year}-`;
  const maxRow = db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) AS m FROM requisition WHERE id LIKE ?`
  ).get(prefix.length + 1, `${prefix}%`);
  const seq = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ---------- 创建 POST /requisition/requests ----------
async function createRequisition(app, req, reply) {
  const body = req.body || {};
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/requests', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canRequisition(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无创建领取单权限' });
  }
  const {
    applicant_id, department, urgency = '一般-日常补充', req_type = null,
    reason = null, approver_id = null, items, depot_id = 'DP-001'
  } = body;
  if (!applicant_id || !Array.isArray(items) || items.length === 0) {
    return reply.code(400).send({ ok: false, error: '需要 applicant_id/items' });
  }
  const URGENCY = ['一般-日常补充', '较急-3日内需要', '紧急-当日需要'];
  if (!URGENCY.includes(urgency)) {
    return reply.code(400).send({ ok: false, error: `urgency 须为 ${URGENCY.join('|')}` });
  }

  // 校验仓库存在
  const dep = app.db.prepare('SELECT id FROM depot WHERE id = ?').get(depot_id);
  if (!dep) return reply.code(404).send({ ok: false, error: `仓库 ${depot_id} 不存在` });

  const reqId = nextReqId(app.db);

  // 校验物品(跨仓/存在性)
  let lines;
  try {
    lines = items.map((it, idx) => {
      const { item_id, qty } = it;
      if (!item_id || !qty || qty < 1) {
        throw new ApiError(400, { ok: false, error: `第 ${idx + 1} 行 item_id/qty 非法` });
      }
      const inv = app.db.prepare('SELECT depot_id, stock FROM inventory_item WHERE id = ? AND depot_id = ?').get(item_id, depot_id);
      if (!inv) {
        const elsewhere = app.db.prepare('SELECT depot_id FROM inventory_item WHERE id = ? LIMIT 1').get(item_id);
        if (elsewhere && elsewhere.depot_id !== depot_id) {
          throw new ApiError(400, {
            ok: false, code: 'DEPOT_MISMATCH',
            error: `物资 ${item_id} 属于仓 ${elsewhere.depot_id},不能从 ${depot_id} 出库`,
            item_id, item_depot: elsewhere.depot_id, requested_depot: depot_id,
          });
        }
        throw new ApiError(404, { ok: false, error: `物资 ${item_id} 不存在或不在仓库 ${depot_id}` });
      }
      return { line_no: idx + 1, item_id, qty };
    });
  } catch (e) {
    if (e instanceof ApiError) return reply.code(e.status).send(e.body);
    throw e;
  }

  app.db.transaction(() => {
    app.db.prepare(
      `INSERT INTO requisition (id, applicant_id, department, urgency, req_type, reason,
                                approver_id, depot_id, status, current_step, total_steps)
       VALUES (?,?,?,?,?,?,?,?, '审批中', 0, 2)`
    ).run(reqId, applicant_id, department || null, urgency, req_type, reason,
          approver_id, depot_id);

    for (const ln of lines) {
      app.db.prepare(
        `INSERT INTO requisition_line (requisition_id, line_no, item_id, qty)
         VALUES (?,?,?,?)`
      ).run(reqId, ln.line_no, ln.item_id, ln.qty);
    }

    recordEvent(app.db, {
      ref_type: 'requisition', ref_id: reqId, step_no: 0,
      event: 'step_started',
      actor_id: req.principal.employee_id,
      actor_role: '申请人',
      payload: { action: 'create', urgency, items, depot_id }
    });
  })();

  const result = { ok: true, id: reqId, status: '审批中', lines: lines.length };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/requests',
                   req.principal.employee_id, 201, result);
  return reply.code(201).send(result);
}

// ---------- 审批 POST /requisition/:id/approve ----------
async function approveRequisition(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/approve', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const rq = app.db.prepare('SELECT * FROM requisition WHERE id = ?').get(id);
  if (!rq) return reply.code(404).send({ ok: false, error: `领取单 ${id} 不存在` });
  if (rq.status !== '审批中') {
    return reply.code(400).send({ ok: false, error: `当前状态 ${rq.status},不能审批(应审批中)` });
  }

  // 防自审
  if (rq.applicant_id === req.principal.employee_id) {
    return reply.code(403).send({ ok: false, error: '审批人不能与申请人相同' });
  }
  if (!canApproveRequisition(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无审批权限(需 admin_level>=1 或领取审批权)' });
  }

  const approvalId = `APR-R-${Date.now()}`;
  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE requisition SET status = '已批准', current_step = 1, approval_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(approvalId, id);

    // 生成 2 步工作流,step1 进行中
    app.db.prepare(
      `INSERT OR REPLACE INTO workflow_step (ref_type, ref_id, step_no, name, assignee_id, status, started_at)
       VALUES ('requisition', ?, 1, '仓库出库', ?, '进行中', CURRENT_TIMESTAMP)`
    ).run(id, req.principal.employee_id);
    app.db.prepare(
      `INSERT OR REPLACE INTO workflow_step (ref_type, ref_id, step_no, name, assignee_id, status)
       VALUES ('requisition', ?, 2, '领取人签收', ?, '待执行')`
    ).run(id, rq.applicant_id);

    recordEvent(app.db, {
      ref_type: 'requisition', ref_id: id, step_no: 1,
      event: 'approval_granted',
      actor_id: req.principal.employee_id,
      actor_role: '审批人',
      payload: { approval_id: approvalId }
    });
  })();

  const result = { ok: true, id, status: '已批准', approval_id: approvalId };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/approve',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 驳回 POST /requisition/:id/reject ----------
async function rejectRequisition(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/reject', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const rq = app.db.prepare('SELECT * FROM requisition WHERE id = ?').get(id);
  if (!rq) return reply.code(404).send({ ok: false, error: `领取单 ${id} 不存在` });
  if (rq.status !== '审批中') {
    return reply.code(400).send({ ok: false, error: `当前状态 ${rq.status},不能驳回(应审批中)` });
  }
  if (rq.applicant_id === req.principal.employee_id) {
    return reply.code(403).send({ ok: false, error: '审批人不能与申请人相同' });
  }
  if (!canApproveRequisition(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无审批权限' });
  }

  const note = req.body?.note || null;
  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE requisition SET status = '已驳回', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(id);
    recordEvent(app.db, {
      ref_type: 'requisition', ref_id: id, step_no: 0,
      event: 'cancel',
      actor_id: req.principal.employee_id,
      actor_role: '审批人',
      payload: { action: 'reject', note }
    });
  })();

  const result = { ok: true, id, status: '已驳回' };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/reject',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- step1 出库 POST /requisition/:id/issue ----------
async function issueRequisition(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/issue', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canRequisition(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无出库权限' });
  }

  const rq = app.db.prepare('SELECT * FROM requisition WHERE id = ?').get(id);
  if (!rq) return reply.code(404).send({ ok: false, error: `领取单 ${id} 不存在` });

  // 审批强制前置(G3)
  const requireApproval = getPolicy(app.db, 'requisition.require_approval', 'true') === 'true';
  if (requireApproval && rq.status !== '已批准') {
    return reply.code(400).send({ ok: false, error: `未审批完成(当前 ${rq.status}),不能出库` });
  }
  if (rq.status !== '已批准' && rq.status !== '发放中') {
    return reply.code(400).send({ ok: false, error: `状态 ${rq.status} 不允许出库` });
  }

  const lines = app.db.prepare(
    'SELECT * FROM requisition_line WHERE requisition_id = ? ORDER BY line_no'
  ).all(id);

  try {
    app.db.transaction(() => {
      for (const ln of lines) {
        const inv = app.db.prepare(
          'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
        ).get(ln.item_id, rq.depot_id);
        if (!inv) throw new ApiError(404, { ok: false, error: `物资 ${ln.item_id} 不在仓库 ${rq.depot_id}` });
        if (inv.stock < ln.qty) {
          throw new ApiError(409, {
            ok: false, error: `物资 ${ln.item_id} 库存不足`,
            item_id: ln.item_id, available: inv.stock, requested: ln.qty,
          });
        }
        const updated = app.db.prepare(
          `UPDATE inventory_item SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND depot_id = ? AND stock >= ?`
        ).run(ln.qty, ln.item_id, rq.depot_id, ln.qty);
        if (updated.changes === 0) {
          const cur = app.db.prepare(
            'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
          ).get(ln.item_id, rq.depot_id);
          throw new ApiError(409, {
            ok: false, error: `物资 ${ln.item_id} 库存不足`,
            item_id: ln.item_id, available: cur ? cur.stock : 0, requested: ln.qty,
          });
        }

        const item = app.db.prepare(
          'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
        ).get(ln.item_id, rq.depot_id);
        app.db.prepare(
          `INSERT INTO stock_movement (item_id, delta, reason, ref_type, ref_id, line_no, qty_after, actor_id, depot_id)
           VALUES (?, ?, 'requisition_out', 'requisition', ?, ?, ?, ?, ?)`
        ).run(ln.item_id, -ln.qty, id, ln.line_no, item.stock, req.principal.employee_id, rq.depot_id);
      }

      // 状态:已批准 → 发放中(step1 完成,step2 进行中)
      app.db.prepare(
        `UPDATE requisition SET status = '发放中', current_step = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(id);

      app.db.prepare(
        `UPDATE workflow_step SET status = '已完成', completed_at = CURRENT_TIMESTAMP
         WHERE ref_type = 'requisition' AND ref_id = ? AND step_no = 1`
      ).run(id);
      app.db.prepare(
        `UPDATE workflow_step SET status = '进行中', started_at = CURRENT_TIMESTAMP
         WHERE ref_type = 'requisition' AND ref_id = ? AND step_no = 2`
      ).run(id);

      recordEvent(app.db, {
        ref_type: 'requisition', ref_id: id, step_no: 1,
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
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/issue',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- step2 领取人签收 POST /requisition/:id/receive ----------
async function receiveRequisition(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/receive', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  const rq = app.db.prepare('SELECT * FROM requisition WHERE id = ?').get(id);
  if (!rq) return reply.code(404).send({ ok: false, error: `领取单 ${id} 不存在` });
  if (rq.status !== '发放中') {
    return reply.code(400).send({ ok: false, error: `状态 ${rq.status} 不允许签收(应发放中)` });
  }

  // 仅领取人本人可签(2步流程无代签白名单,领取是个人行为)
  if (req.principal.employee_id !== rq.applicant_id) {
    return reply.code(403).send({ ok: false, error: '仅领取人本人可签收' });
  }

  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE requisition SET status = '已完成', current_step = 2, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(id);

    app.db.prepare(
      `UPDATE workflow_step SET status = '已完成', completed_at = CURRENT_TIMESTAMP
       WHERE ref_type = 'requisition' AND ref_id = ? AND step_no = 2`
    ).run(id);

    recordEvent(app.db, {
      ref_type: 'requisition', ref_id: id, step_no: 2,
      event: 'signoff',
      actor_id: req.principal.employee_id,
      actor_role: req.principal.position || '领取人',
      payload: { received_by: rq.applicant_id }
    });
  })();

  const result = { ok: true, id, status: '已完成' };
  writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /requisition/:id/receive',
                   req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 列表 GET /requisition ----------
async function listRequisitions(app, req, reply) {
  const me = req.principal.employee_id;
  const privileged = canRequisition(app.db, me);

  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  if (!privileged) {
    where.push('(r.applicant_id = ? OR r.approver_id = ?)');
    params.push(me, me);
  }
  if (q.status) { where.push('r.status = ?'); params.push(q.status); }
  if (q.department) { where.push('r.department = ?'); params.push(q.department); }
  if (q.applicant_id) { where.push('r.applicant_id = ?'); params.push(Number(q.applicant_id)); }
  if (q.depot_id) { where.push('r.depot_id = ?'); params.push(q.depot_id); }
  if (q.urgency) { where.push('r.urgency = ?'); params.push(q.urgency); }
  if (q.from) { where.push("DATE(r.requested_at) >= DATE(?)"); params.push(q.from); }
  if (q.to) { where.push("DATE(r.requested_at) <= DATE(?)"); params.push(q.to); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = app.db.prepare(
    `SELECT COUNT(*) AS c FROM requisition r ${whereSql}`
  ).get(...params).c;
  const items = app.db.prepare(
    `SELECT r.id, r.applicant_id, r.department, r.urgency, r.req_type, r.reason,
            r.approver_id, r.approval_id, r.depot_id, r.status, r.current_step,
            r.total_steps, r.requested_at, r.updated_at
       FROM requisition r ${whereSql}
       ORDER BY r.requested_at DESC, r.id DESC
       LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return reply.send({
    ok: true, page, limit, total,
    pages: Math.ceil(total / limit),
    items,
  });
}

// ---------- 详情 GET /requisition/:id ----------
async function getRequisition(app, req, reply) {
  const { id } = req.params;
  if (!canViewRequisition(app.db, req.principal.employee_id, id)) {
    return reply.code(403).send({ ok: false, error: '无权查看该单据' });
  }
  const rq = app.db.prepare('SELECT * FROM requisition WHERE id = ?').get(id);
  if (!rq) return reply.code(404).send({ ok: false, error: `领取单 ${id} 不存在` });

  const lines = app.db.prepare(
    `SELECT line_no, item_id, qty FROM requisition_line
      WHERE requisition_id = ? ORDER BY line_no`
  ).all(id);
  const steps = app.db.prepare(
    `SELECT step_no, name, assignee_id, status, started_at, completed_at
       FROM workflow_step WHERE ref_type = 'requisition' AND ref_id = ? ORDER BY step_no`
  ).all(id);

  return reply.send({
    ok: true,
    requisition: { ...rq, lines, steps },
  });
}

// ---------- 哈希链 GET /requisition/:id/chain ----------
function verifyRequisitionChain(db, refId) {
  return verifyChain(db, 'requisition', refId);
}

// ---------- 注册路由 ----------
async function registerRequisitionRoutes(app) {
  if (!app.db) {
    app.log.warn('[requisition] db 不可用,跳过 requisition 路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('requisition 路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  app.post('/requisition/requests', preAuth, async (req, reply) => createRequisition(app, req, reply));
  app.get('/requisition', preAuth, async (req, reply) => listRequisitions(app, req, reply));
  app.get('/requisition/:id', preAuth, async (req, reply) => getRequisition(app, req, reply));
  app.post('/requisition/:id/approve', preAuth, async (req, reply) => approveRequisition(app, req, reply));
  app.post('/requisition/:id/reject', preAuth, async (req, reply) => rejectRequisition(app, req, reply));
  app.post('/requisition/:id/issue', preAuth, async (req, reply) => issueRequisition(app, req, reply));
  app.post('/requisition/:id/receive', preAuth, async (req, reply) => receiveRequisition(app, req, reply));
  app.get('/requisition/:id/chain', preAuth, async (req, reply) => {
    if (!canViewRequisition(app.db, req.principal.employee_id, req.params.id)) {
      return reply.code(403).send({ ok: false, error: '无权查看该单据审计链' });
    }
    const v = verifyRequisitionChain(app.db, req.params.id);
    return reply.send({ ok: true, id: req.params.id, ...v });
  });
}

module.exports = {
  registerRequisitionRoutes, canRequisition, canApproveRequisition,
  canViewRequisition, verifyRequisitionChain,
};
