// reports.js — P1-T04 报表 API
// GET /reports/stock-movements   库存流水(按仓/物资/日期范围筛选,分页)
// GET /reports/low-stock         低库存告警(含 INV-004 扫帚场景,A-T11 SQL 版)
// GET /reports/distribution-stats 发放统计(按部门/日期/仓)

const auth = require('./auth');

async function registerReportRoutes(app) {
  if (!app.db) {
    app.log.warn('[reports] db 不可用,跳过报表路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('报表路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  // ---- 库存流水 ----
  app.get('/reports/stock-movements', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'inventory', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无库存查看权限' });
    }
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (q.item_id) { where.push('sm.item_id = ?'); params.push(q.item_id); }
    if (q.depot_id) { where.push('sm.depot_id = ?'); params.push(q.depot_id); }
    if (q.reason) { where.push('sm.reason = ?'); params.push(q.reason); }
    if (q.from) { where.push('DATE(sm.occurred_at) >= DATE(?)'); params.push(q.from); }
    if (q.to) { where.push('DATE(sm.occurred_at) <= DATE(?)'); params.push(q.to); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = app.db.prepare(
      `SELECT COUNT(*) AS c FROM stock_movement sm ${whereSql}`
    ).get(...params).c;
    const items = app.db.prepare(
      `SELECT sm.id, sm.item_id, sm.delta, sm.reason, sm.ref_type, sm.ref_id, sm.line_no,
              sm.qty_after, sm.actor_id, sm.occurred_at, sm.depot_id,
              i.name AS item_name, e.name AS actor_name
         FROM stock_movement sm
         LEFT JOIN inventory_item i ON i.id = sm.item_id AND i.depot_id = sm.depot_id
         LEFT JOIN employees e ON e.employee_id = sm.actor_id
         ${whereSql}
         ORDER BY sm.occurred_at DESC, sm.id DESC
         LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    // 汇总
    const summary = app.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN sm.delta > 0 THEN sm.delta ELSE 0 END),0) AS total_in,
              COALESCE(SUM(CASE WHEN sm.delta < 0 THEN -sm.delta ELSE 0 END),0) AS total_out
         FROM stock_movement sm ${whereSql}`
    ).get(...params);

    return reply.send({
      ok: true, page, limit, total,
      pages: Math.ceil(total / limit),
      summary,
      items,
    });
  });

  // ---- 低库存告警(A-T11 SQL 版)----
  app.get('/reports/low-stock', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'inventory', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无库存查看权限' });
    }
    const q = req.query || {};
    const depot = q.depot_id;

    const where = ['i.stock <= i.min_stock'];
    const params = [];
    if (depot) { where.push('i.depot_id = ?'); params.push(depot); }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const items = app.db.prepare(
      `SELECT i.id, i.name, i.category, i.unit, i.stock, i.min_stock,
              i.unit_cost, i.depot_id, d.name AS depot_name,
              (i.min_stock - i.stock) AS shortage,
              CASE WHEN i.stock = 0 THEN 'critical' ELSE 'warning' END AS severity
         FROM inventory_item i
         LEFT JOIN depot d ON d.id = i.depot_id
         ${whereSql}
         ORDER BY (i.stock * 1.0 / CASE WHEN i.min_stock > 0 THEN i.min_stock ELSE 1 END) ASC,
                  i.id`
    ).all(...params);

    return reply.send({
      ok: true,
      count: items.length,
      critical: items.filter(x => x.severity === 'critical').length,
      items,
    });
  });

  // ---- 发放统计 ----
  app.get('/reports/distribution-stats', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'distribution', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无发放查看权限' });
    }
    const q = req.query || {};
    const where = [];
    const params = [];
    if (q.from) { where.push("DATE(d.requested_at) >= DATE(?)"); params.push(q.from); }
    if (q.to) { where.push("DATE(d.requested_at) <= DATE(?)"); params.push(q.to); }
    if (q.depot_id) { where.push('d.depot_id = ?'); params.push(q.depot_id); }
    if (q.department) { where.push('d.department = ?'); params.push(q.department); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // 按状态分组
    const byStatus = app.db.prepare(
      `SELECT d.status, COUNT(*) AS count, COALESCE(SUM(d.total_cost),0) AS total_cost
         FROM distribution d ${whereSql}
         GROUP BY d.status`
    ).all(...params);

    // 按部门分组
    const byDept = app.db.prepare(
      `SELECT COALESCE(d.department,'未指定') AS department,
              COUNT(*) AS count,
              COALESCE(SUM(d.total_people),0) AS total_people,
              COALESCE(SUM(d.total_cost),0) AS total_cost
         FROM distribution d ${whereSql}
         GROUP BY d.department
         ORDER BY count DESC`
    ).all(...params);

    // 总计
    const total = app.db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(d.total_people),0) AS total_people,
              COALESCE(SUM(d.total_cost),0) AS total_cost
         FROM distribution d ${whereSql}`
    ).get(...params);

    // Top 物资(按发放数量)
    const topItems = app.db.prepare(
      `SELECT dl.item_id, i.name AS item_name,
              COALESCE(SUM(dl.qty),0) AS total_qty,
              COALESCE(SUM(dl.qty * i.unit_cost),0) AS total_cost
         FROM distribution_line dl
         JOIN distribution d ON d.id = dl.distribution_id
         LEFT JOIN inventory_item i ON i.id = dl.item_id AND i.depot_id = d.depot_id
         ${whereSql}
         GROUP BY dl.item_id
         ORDER BY total_qty DESC
         LIMIT 10`
    ).all(...params);

    return reply.send({
      ok: true,
      total,
      by_status: byStatus,
      by_department: byDept,
      top_items: topItems,
    });
  });
}

module.exports = { registerReportRoutes };
