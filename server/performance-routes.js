// performance-routes.js — P2-T01 绩效模块路由
// GET  /performance/weights                         岗位权重画像
// POST /performance/calculate                      纯计算(不落库,幂等)
// POST /performance/records                        落库/确认/申诉(状态机强制)
// GET  /performance/records                        分页查询
// GET  /performance/records/:employee_id/:period   单条查询
// 权限:module='performance',actions=view/calculate/save/confirm/appeal
// 状态机:draft → confirmed → appealed(非法转移直接拒)

const auth = require('./auth');
const perf = require('./performance');

async function registerPerformanceRoutes(app) {
  if (!app.db) {
    app.log.warn('[performance] db 不可用,跳过绩效路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('绩效路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  // ---- GET /performance/weights 岗位权重画像 ----
  app.get('/performance/weights', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    return reply.send({
      ok: true,
      items: Object.entries(perf.WEIGHT_PROFILES).map(([position, weights]) => ({
        position,
        weights,
        active_dimensions: perf.ACTIVE_DIMENSIONS,
        deferred_dimensions: perf.DEFERRED_DIMENSIONS
      })),
      grade_thresholds: { S: 95, A: 85, B: 75, C: 60 }
    });
  });

  // ---- POST /performance/calculate 纯计算(不落库)----
  app.post('/performance/calculate', preAuth, async (req, reply) => {
    const { employee_id, period } = req.body || {};
    if (!employee_id || !period) {
      return reply.code(400).send({ ok: false, error: '需要 employee_id 与 period' });
    }
    const empId = Number(employee_id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return reply.code(400).send({ ok: false, error: 'employee_id 需为正整数' });
    }
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'calculate', empId)) {
      return reply.code(403).send({ ok: false, error: '无绩效计算权限' });
    }
    try {
      const result = perf.calculatePerformance(app.db, empId, period);
      return reply.send({ ok: true, result });
    } catch (e) {
      if (String(e.message).includes('员工不存在')) {
        return reply.code(404).send({ ok: false, error: '员工不存在' });
      }
      throw e;
    }
  });

  // ---- POST /performance/records 落库/确认/申诉(状态机)----
  app.post('/performance/records', preAuth, async (req, reply) => {
    const { employee_id, period, status, comment, comment_by } = req.body || {};
    if (!employee_id || !period) {
      return reply.code(400).send({ ok: false, error: '需要 employee_id 与 period' });
    }
    const empId = Number(employee_id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return reply.code(400).send({ ok: false, error: 'employee_id 需为正整数' });
    }
    if (!['draft', 'confirmed', 'appealed'].includes(status)) {
      return reply.code(400).send({ ok: false, error: 'status 需为 draft/confirmed/appealed' });
    }

    const action = status === 'draft' ? 'save' : (status === 'confirmed' ? 'confirm' : 'appeal');
    if (!auth.hasPermission(app.db, req.principal, 'performance', action, empId)) {
      return reply.code(403).send({ ok: false, error: `无权限:performance.${action}` });
    }

    // 先计算(引擎口径确定性),再按状态机落库
    const result = perf.calculatePerformance(app.db, empId, period);
    const existing = perf.getPerformanceRecord(app.db, empId, period);

    if (status === 'draft') {
      if (existing) {
        // 唯一约束:同员工同周期已有记录,拒绝静默覆盖
        return reply.code(409).send({ ok: false, error: '该周期考核记录已存在', record: existing });
      }
      const id = perf.savePerformanceRecord(app.db, result, {
        status: 'draft', comment: comment || null, comment_by: comment_by || null
      });
      return reply.code(201).send({ ok: true, id, record: perf.getPerformanceRecord(app.db, empId, period) });
    }

    // confirmed / appealed:必须存在记录且符合状态机
    if (!existing) {
      return reply.code(404).send({ ok: false, error: '考核记录不存在,无法确认/申诉' });
    }
    if (status === 'confirmed' && existing.status !== 'draft') {
      return reply.code(409).send({ ok: false, error: '仅草稿状态可确认', record: existing });
    }
    if (status === 'appealed' && existing.status !== 'confirmed') {
      return reply.code(409).send({ ok: false, error: '仅已确认状态可申诉', record: existing });
    }
    app.db.prepare(
      `UPDATE performance_record
          SET status = ?, comment = ?, comment_by = ?,
              confirmed_at = COALESCE(?, confirmed_at)
        WHERE id = ?`
    ).run(
      status, comment || null, comment_by || null,
      status === 'confirmed' ? new Date().toISOString() : null,
      existing.id
    );
    return reply.send({ ok: true, record: perf.getPerformanceRecord(app.db, empId, period) });
  });

  // ---- GET /performance/records 分页查询 ----
  app.get('/performance/records', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (q.employee_id) { where.push('pr.employee_id = ?'); params.push(Number(q.employee_id)); }
    if (q.period) { where.push('pr.period = ?'); params.push(q.period); }
    if (q.status) { where.push('pr.status = ?'); params.push(q.status); }
    if (q.grade) { where.push('pr.grade = ?'); params.push(q.grade); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = app.db.prepare(
      `SELECT COUNT(*) AS c FROM performance_record pr ${whereSql}`
    ).get(...params).c;
    const rows = app.db.prepare(
      `SELECT pr.id, pr.employee_id, pr.period, pr.period_type, pr.total_score, pr.grade,
              pr.status, pr.comment, pr.comment_by, pr.created_at, pr.confirmed_at,
              e.name AS emp_name, e.position, e.department
         FROM performance_record pr
         LEFT JOIN employees e ON e.employee_id = pr.employee_id
         ${whereSql}
         ORDER BY pr.period DESC, pr.id DESC
         LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const items = rows.map(r => ({
      id: r.id, employee_id: r.employee_id, emp_name: r.emp_name,
      position: r.position, department: r.department,
      period: r.period, period_type: r.period_type,
      total_score: r.total_score, grade: r.grade, status: r.status,
      comment: r.comment, comment_by: r.comment_by,
      created_at: r.created_at, confirmed_at: r.confirmed_at
    }));

    return reply.send({ ok: true, page, limit, total, pages: Math.ceil(total / limit), items });
  });

  // ---- GET /performance/records/:employee_id/:period 单条查询 ----
  app.get('/performance/records/:employee_id/:period', preAuth, async (req, reply) => {
    const empId = Number(req.params.employee_id);
    const period = req.params.period;
    if (!Number.isInteger(empId) || empId <= 0) {
      return reply.code(400).send({ ok: false, error: 'employee_id 需为正整数' });
    }
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', empId)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    const row = perf.getPerformanceRecord(app.db, empId, period);
    if (!row) {
      return reply.code(404).send({ ok: false, error: '考核记录不存在' });
    }
    return reply.send({
      ok: true,
      record: {
        id: row.id, employee_id: row.employee_id, period: row.period,
        period_type: row.period_type,
        scores: JSON.parse(row.scores_json),
        weights: JSON.parse(row.weights_json),
        total_score: row.total_score, grade: row.grade,
        status: row.status, comment: row.comment, comment_by: row.comment_by,
        created_at: row.created_at, confirmed_at: row.confirmed_at
      }
    });
  });
}

module.exports = { registerPerformanceRoutes };
