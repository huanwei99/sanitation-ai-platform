// inbound.js — P1-T02 入库+质检门 API
// A-T9 质检门:入库单先待质检;质检合格 → status='已完成' + 按 inbound_line 写 stock_movement(delta>0, reason='inbound')
//            质检不合格 → 不写 stock_movement,不增库存,记录 quality_result/quality_note,状态保持待质检
//            已质检(无论合格/不合格)的入库单不可重复质检
// 防自检:质检人不能与入库操作人相同
// 全程写哈希链(recordEvent: create / quality_passed / quality_failed)

const { recordEvent, verifyChain } = require('./chain');
const { readIdempotency, writeIdempotency, ApiError } = require('./distribution');

// ---------- 权限 ----------
// 入库操作权:admin_level>=1 或 modules.inventory 带 edit/ALL
function canInbound(db, employeeId) {
  const p = db.prepare('SELECT level, scope, modules, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  if (p.admin_level >= 1) return true;
  let mods = {};
  try { mods = JSON.parse(p.modules || '{}'); } catch { mods = {}; }
  const inv = mods.inventory;
  return Array.isArray(inv) && (inv.includes('edit') || inv.includes('ALL'));
}

// 可见性:有入库操作权 或 是该单操作人/质检人
function canViewInbound(db, employeeId, inboundId) {
  if (canInbound(db, employeeId)) return true;
  const r = db.prepare('SELECT operator_id, quality_inspector_id FROM inbound_record WHERE id = ?').get(inboundId);
  if (!r) return false;
  return r.operator_id === employeeId || r.quality_inspector_id === employeeId;
}

// ---------- 单号 IN-{year}-{seq} ----------
function nextInboundId(db) {
  const year = new Date().getFullYear();
  const prefix = `IN-${year}-`;
  const maxRow = db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) AS m FROM inbound_record WHERE id LIKE ?`
  ).get(prefix.length + 1, `${prefix}%`);
  const seq = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ---------- 创建入库单 POST /inbound/requests ----------
async function createInbound(app, req, reply) {
  const body = req.body || {};
  const idem = readIdempotency(app.db, req.headers['idempotency-key'],
                               'POST /inbound/requests', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canInbound(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无创建入库单权限' });
  }
  const {
    date = null, type = '采购入库', supplier = null,
    operator_id = null, items, depot_id = 'DP-001', approval_id = null,
  } = body;
  if (!Array.isArray(items) || items.length === 0) {
    return reply.code(400).send({ ok: false, error: '需要 items(至少一行)' });
  }

  // 仓库必须存在
  const dep = app.db.prepare('SELECT id FROM depot WHERE id = ?').get(depot_id);
  if (!dep) return reply.code(404).send({ ok: false, error: `仓库 ${depot_id} 不存在` });

  const inboundId = nextInboundId(app.db);
  const opId = operator_id || req.principal.employee_id;

  // 校验物品(存在性 + 跨仓 A-T13)+ 计算总金额
  let lines;
  let totalCost = 0;
  try {
    lines = items.map((it, idx) => {
      const { item_id, qty, unit_cost } = it;
      if (!item_id || !qty || qty < 1) {
        throw new ApiError(400, { ok: false, error: `第 ${idx + 1} 行 item_id/qty 非法(qty 须 >= 1)` });
      }
      const inv = app.db.prepare(
        'SELECT id, depot_id, unit_cost FROM inventory_item WHERE id = ? AND depot_id = ?'
      ).get(item_id, depot_id);
      if (!inv) {
        const elsewhere = app.db.prepare(
          'SELECT depot_id FROM inventory_item WHERE id = ? LIMIT 1'
        ).get(item_id);
        if (elsewhere && elsewhere.depot_id !== depot_id) {
          throw new ApiError(400, {
            ok: false, code: 'DEPOT_MISMATCH',
            error: `物资 ${item_id} 属于仓 ${elsewhere.depot_id},不能入库到 ${depot_id}`,
            item_id, item_depot: elsewhere.depot_id, requested_depot: depot_id,
          });
        }
        throw new ApiError(404, { ok: false, error: `物资 ${item_id} 不存在或不在仓库 ${depot_id}` });
      }
      const cost = (unit_cost != null) ? unit_cost : inv.unit_cost;
      if (!Number.isFinite(cost) || cost < 0) {
        throw new ApiError(400, { ok: false, error: `第 ${idx + 1} 行 unit_cost 非法` });
      }
      totalCost += qty * cost;
      return { line_no: idx + 1, item_id, qty, unit_cost: cost };
    });
  } catch (e) {
    if (e instanceof ApiError) return reply.code(e.status).send(e.body);
    throw e;
  }

  const inDate = date || new Date().toISOString().slice(0, 10);

  app.db.transaction(() => {
    app.db.prepare(
      `INSERT INTO inbound_record (id, date, type, supplier, total_cost,
                                   operator_id, status, approval_id, depot_id,
                                   quality_inspector_id, quality_result, quality_note)
       VALUES (?,?,?,?,?,?, '待质检', ?, ?, NULL, '待检', NULL)`
    ).run(inboundId, inDate, type, supplier, totalCost,
          opId, approval_id, depot_id);

    for (const ln of lines) {
      app.db.prepare(
        `INSERT INTO inbound_line (inbound_id, line_no, item_id, qty, unit_cost)
         VALUES (?,?,?,?,?)`
      ).run(inboundId, ln.line_no, ln.item_id, ln.qty, ln.unit_cost);
    }

    recordEvent(app.db, {
      ref_type: 'inbound', ref_id: inboundId, step_no: 0,
      event: 'created',
      actor_id: req.principal.employee_id,
      actor_role: '库管员',
      payload: { action: 'create', type, supplier, depot_id, total_cost: totalCost, items }
    });
  })();

  const result = { ok: true, id: inboundId, status: '待质检',
                   total_cost: totalCost, lines: lines.length, depot_id };
  writeIdempotency(app.db, req.headers['idempotency-key'],
                   'POST /inbound/requests', req.principal.employee_id, 201, result);
  return reply.code(201).send(result);
}

// ---------- 质检 POST /inbound/:id/quality ----------
// A-T9 质检门:
//   result='合格'   → status='已完成' + 写 stock_movement(delta=qty, reason='inbound') + 记 quality_passed 事件
//   result='不合格' → status 保持 '待质检',不写 stock_movement,不增库存,记 quality_failed 事件
async function qualityCheck(app, req, reply) {
  const { id } = req.params;
  const body = req.body || {};
  const idem = readIdempotency(app.db, req.headers['idempotency-key'],
                               'POST /inbound/:id/quality', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canInbound(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无质检权限' });
  }

  const inbound = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
  if (!inbound) return reply.code(404).send({ ok: false, error: `入库单 ${id} 不存在` });

  // 状态前置:必须待质检
  if (inbound.status !== '待质检') {
    return reply.code(400).send({
      ok: false, error: `当前状态 ${inbound.status},不允许质检(应待质检)`,
    });
  }
  // 已有质检结果不可重检
  if (inbound.quality_result && inbound.quality_result !== '待检') {
    return reply.code(400).send({
      ok: false, error: `已有质检结果 ${inbound.quality_result},不可重复质检`,
    });
  }

  const { result, note = null } = body;
  if (!['合格', '不合格'].includes(result)) {
    return reply.code(400).send({ ok: false, error: 'result 必须为 合格 或 不合格' });
  }

  // 防自检:质检人不能与入库操作人相同
  if (inbound.operator_id === req.principal.employee_id) {
    return reply.code(403).send({ ok: false, error: '质检人不能与入库操作人相同' });
  }

  const lines = app.db.prepare(
    'SELECT * FROM inbound_line WHERE inbound_id = ? ORDER BY line_no'
  ).all(id);

  const inspectorId = req.principal.employee_id;
  const inspectorRole = req.principal.position || '质检员';

  try {
    app.db.transaction(() => {
      if (result === '合格') {
        // 合格 → 写流水 + 增库存 + 状态推到 已完成
        for (const ln of lines) {
          // 更新库存(同仓)
          const updated = app.db.prepare(
            `UPDATE inventory_item SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND depot_id = ?`
          ).run(ln.qty, ln.item_id, inbound.depot_id);
          if (updated.changes === 0) {
            throw new ApiError(409, {
              ok: false, error: `物资 ${ln.item_id} 不在仓库 ${inbound.depot_id}`,
            });
          }
          const cur = app.db.prepare(
            'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
          ).get(ln.item_id, inbound.depot_id);
          app.db.prepare(
            `INSERT INTO stock_movement (item_id, delta, reason, ref_type, ref_id,
                                         line_no, qty_after, actor_id, depot_id)
             VALUES (?, ?, 'inbound', 'inbound', ?, ?, ?, ?, ?)`
          ).run(ln.item_id, ln.qty, id, ln.line_no, cur.stock, inspectorId, inbound.depot_id);
        }

        app.db.prepare(
          `UPDATE inbound_record
              SET status = '已完成',
                  quality_inspector_id = ?,
                  quality_result = ?,
                  quality_note = ?
            WHERE id = ?`
        ).run(inspectorId, result, note, id);

        recordEvent(app.db, {
          ref_type: 'inbound', ref_id: id, step_no: 1,
          event: 'quality_passed',
          actor_id: inspectorId,
          actor_role: inspectorRole,
          payload: {
            result, note,
            lines: lines.map(l => ({ item_id: l.item_id, qty: l.qty })),
            stock_increased: lines.reduce((s, l) => s + l.qty, 0),
          },
        });
      } else {
        // 不合格 → 仅记录,不写 stock_movement,不增库存
        app.db.prepare(
          `UPDATE inbound_record
              SET quality_inspector_id = ?,
                  quality_result = ?,
                  quality_note = ?
            WHERE id = ?`
        ).run(inspectorId, result, note, id);

        recordEvent(app.db, {
          ref_type: 'inbound', ref_id: id, step_no: 1,
          event: 'quality_failed',
          actor_id: inspectorId,
          actor_role: inspectorRole,
          payload: { result, note, stock_increased: 0 },
        });
      }
    })();
  } catch (e) {
    if (e instanceof ApiError) return reply.code(e.status).send(e.body);
    return reply.code(400).send({ ok: false, error: e.message });
  }

  const after = app.db.prepare('SELECT status, quality_result FROM inbound_record WHERE id = ?').get(id);
  const res = {
    ok: true, id,
    status: after.status,
    quality_result: after.quality_result,
    stock_changed: result === '合格',
  };
  writeIdempotency(app.db, req.headers['idempotency-key'],
                   'POST /inbound/:id/quality', req.principal.employee_id, 200, res);
  return reply.send(res);
}

// ---------- 列表 GET /inbound ----------
async function listInbound(app, req, reply) {
  const me = req.principal.employee_id;
  const privileged = canInbound(app.db, me);

  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  if (!privileged) {
    where.push('(r.operator_id = ? OR r.quality_inspector_id = ?)');
    params.push(me, me);
  }
  if (q.status) { where.push('r.status = ?'); params.push(q.status); }
  if (q.depot_id) { where.push('r.depot_id = ?'); params.push(q.depot_id); }
  if (q.supplier) { where.push('r.supplier = ?'); params.push(q.supplier); }
  if (q.type) { where.push('r.type = ?'); params.push(q.type); }
  if (q.quality_result) { where.push('r.quality_result = ?'); params.push(q.quality_result); }
  if (q.from) { where.push('DATE(r.date) >= DATE(?)'); params.push(q.from); }
  if (q.to) { where.push('DATE(r.date) <= DATE(?)'); params.push(q.to); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = app.db.prepare(
    `SELECT COUNT(*) AS c FROM inbound_record r ${whereSql}`
  ).get(...params).c;
  const items = app.db.prepare(
    `SELECT r.id, r.date, r.type, r.supplier, r.total_cost,
            r.operator_id, r.status, r.approval_id,
            r.quality_inspector_id, r.quality_result, r.quality_note,
            r.depot_id, r.created_at
       FROM inbound_record r ${whereSql}
       ORDER BY r.date DESC, r.id DESC
       LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return reply.send({
    ok: true, page, limit, total,
    pages: Math.ceil(total / limit),
    items,
  });
}

// ---------- 详情 GET /inbound/:id ----------
async function getInbound(app, req, reply) {
  const { id } = req.params;
  if (!canViewInbound(app.db, req.principal.employee_id, id)) {
    return reply.code(403).send({ ok: false, error: '无权查看该入库单' });
  }
  const inbound = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
  if (!inbound) return reply.code(404).send({ ok: false, error: `入库单 ${id} 不存在` });

  const lines = app.db.prepare(
    `SELECT line_no, item_id, qty, unit_cost, (qty * unit_cost) AS line_cost
       FROM inbound_line WHERE inbound_id = ? ORDER BY line_no`
  ).all(id);

  return reply.send({ ok: true, inbound: { ...inbound, lines } });
}

// ---------- 哈希链 GET /inbound/:id/chain ----------
async function getInboundChain(app, req, reply) {
  const { id } = req.params;
  if (!canViewInbound(app.db, req.principal.employee_id, id)) {
    return reply.code(403).send({ ok: false, error: '无权查看该入库单审计链' });
  }
  const v = verifyChain(app.db, 'inbound', id);
  return reply.send({ ok: true, id, ...v });
}

// ---------- 注册路由 ----------
async function registerInboundRoutes(app) {
  if (!app.db) {
    app.log.warn('[inbound] db 不可用,跳过 inbound 路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('inbound 路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  app.post('/inbound/requests', preAuth, async (req, reply) => createInbound(app, req, reply));
  app.get('/inbound', preAuth, async (req, reply) => listInbound(app, req, reply));
  app.get('/inbound/:id', preAuth, async (req, reply) => getInbound(app, req, reply));
  app.post('/inbound/:id/quality', preAuth, async (req, reply) => qualityCheck(app, req, reply));
  app.get('/inbound/:id/chain', preAuth, async (req, reply) => getInboundChain(app, req, reply));
}

module.exports = {
  registerInboundRoutes, canInbound, canViewInbound,
  nextInboundId,
};
