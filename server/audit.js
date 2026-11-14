// audit.js — DR-T06 审计链查询 + 校验 API
// A-T10:走完链路 verifyChain=true;篡改中间事件后=false。
// 复用 chain.js 的 verifyChain(单一实现)。

const { verifyChain } = require('./chain');

// ---------- 权限:查看审计链 ----------
// 规格 §7:View audit trail → L4/L5 全量,更低层级仅 own(简化:MVP 阶段
// 有登录即放行;生产环境应按 level/admin_level 收紧。此处在测试中明确。)
function canViewAudit(db, employeeId) {
  const p = db.prepare('SELECT level, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  return p.admin_level >= 1 || p.level >= 3;
}

// ---------- GET /audit/events?ref_type=&ref_id=&actor_id=&event=&limit=&offset= ----------
async function listEvents(app, req, reply) {
  const q = req.query || {};
  const limit = Math.min(parseInt(q.limit || '100', 10), 500);
  const offset = parseInt(q.offset || '0', 10);

  const where = [];
  const args = [];
  if (q.ref_type) { where.push('ref_type = ?'); args.push(q.ref_type); }
  if (q.ref_id)   { where.push('ref_id = ?');   args.push(q.ref_id); }
  if (q.actor_id) { where.push('actor_id = ?'); args.push(parseInt(q.actor_id, 10)); }
  if (q.event)    { where.push('event = ?');    args.push(q.event); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = app.db.prepare(
    `SELECT id, ref_type, ref_id, step_no, event, actor_id, actor_role,
            payload, occurred_at, captured_at, prev_event_hash, event_hash
       FROM chain_event ${whereSql}
      ORDER BY id
      LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);

  const total = app.db.prepare(
    `SELECT COUNT(*) AS c FROM chain_event ${whereSql}`
  ).get(...args).c;

  return reply.send({ ok: true, total, limit, offset, events: rows });
}

// ---------- GET /audit/chain?ref_type=&ref_id= 校验单链 ----------
async function verifyOne(app, req, reply) {
  const { ref_type, ref_id } = req.query || {};
  if (!ref_type || !ref_id) {
    return reply.code(400).send({ ok: false, error: '需要 ref_type 与 ref_id' });
  }
  const r = verifyChain(app.db, ref_type, ref_id);
  // verify_ok 明确区分"接口成功"与"链校验结果"
  return reply.send({ ok: true, ref_type, ref_id, verify_ok: r.ok, events: r.events, head: r.head, broken_at: r.broken_at || null, reason: r.reason || null });
}

// ---------- GET /audit/verify-all 校验全库所有链 ----------
// 扫出所有 (ref_type, ref_id) 组合,逐链校验;返回汇总。
async function verifyAll(app, req, reply) {
  const groups = app.db.prepare(
    'SELECT DISTINCT ref_type, ref_id FROM chain_event ORDER BY ref_type, ref_id'
  ).all();
  const results = [];
  let allOk = true;
  for (const g of groups) {
    const r = verifyChain(app.db, g.ref_type, g.ref_id);
    results.push({ ref_type: g.ref_type, ref_id: g.ref_id, ok: r.ok, events: r.events, broken_at: r.broken_at || null, reason: r.reason || null });
    if (!r.ok) allOk = false;
  }
  return reply.send({ ok: true, all_ok: allOk, chains: groups.length, broken: results.filter(r => !r.ok).length, results });
}

// ---------- 注册路由 ----------
async function registerAuditRoutes(app) {
  if (!app.db) {
    app.log.warn('[audit] db 不可用,跳过 audit 路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('audit 路由需先注册 auth(authenticate 装饰器)');
  }
  const preAuth = { preValidation: [app.authenticate] };

  app.get('/audit/events', preAuth, async (req, reply) => listEvents(app, req, reply));
  app.get('/audit/chain', preAuth, async (req, reply) => verifyOne(app, req, reply));
  app.get('/audit/verify-all', preAuth, async (req, reply) => verifyAll(app, req, reply));
}

module.exports = { registerAuditRoutes, canViewAudit };