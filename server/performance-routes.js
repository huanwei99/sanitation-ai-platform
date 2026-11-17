// performance-routes.js — 绩效模块路由(P2-T01 引擎 + P2-T02 完整模块)
// GET  /performance/weights                         岗位权重画像(读配置表,回退常量)
// PUT  /performance/weights/:position              岗位权重配置
// GET  /performance/weight-config                  权重配置列表
// POST /performance/calculate                      纯计算(不落库,幂等)
// POST /performance/records                        落库/确认/申诉(状态机强制)
// GET  /performance/records                        分页查询
// GET  /performance/records/:employee_id/:period   单条查询
// POST /performance/records/:employee_id/:period/appeal-decision 申诉裁决
// GET  /performance/records/export                评分导出(CSV)
// POST /performance/rewards                        奖惩录入
// GET  /performance/rewards                        奖惩查询
// GET  /performance/dashboard                     绩效看板
// 权限:module='performance',actions=view/calculate/save/confirm/appeal
// 状态机:draft → confirmed → appealed → 裁决(upheld/overturned)

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
    // 权重画像:优先读配置表(P2-T02 权重可配),无配置行回退常量;保持规范岗位顺序
    const configs = new Map(
      perf.listWeightConfigs(app.db).map(c => [c.position, c.weights])
    );
    return reply.send({
      ok: true,
      items: Object.keys(perf.WEIGHT_PROFILES).map(position => ({
        position,
        weights: configs.get(position) || perf.WEIGHT_PROFILES[position],
        active_dimensions: perf.ACTIVE_DIMENSIONS,
        deferred_dimensions: perf.DEFERRED_DIMENSIONS
      })),
      grade_thresholds: { S: 95, A: 85, B: 75, C: 60 }
    });
  });

  // ---- PUT /performance/weights/:position 岗位权重配置(P2-T02)----
  app.put('/performance/weights/:position', preAuth, async (req, reply) => {
    const position = (req.params.position || '').trim();
    if (!position) {
      return reply.code(400).send({ ok: false, error: '需要岗位名' });
    }
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'save', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效配置权限' });
    }
    const { weights } = req.body || {};
    try {
      const cfg = perf.upsertWeightConfig(app.db, position, weights, String(req.principal.employee_id));
      return reply.send({ ok: true, config: cfg });
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e.message });
    }
  });

  // ---- GET /performance/weight-config 权重配置列表(含修改人/时间)----
  app.get('/performance/weight-config', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    return reply.send({ ok: true, items: perf.listWeightConfigs(app.db) });
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
              confirmed_at = COALESCE(?, confirmed_at),
              appeal_decision = ?
        WHERE id = ?`
    ).run(
      status, comment || null, comment_by || null,
      status === 'confirmed' ? new Date().toISOString() : null,
      status === 'appealed' ? 'pending' : null,
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
              pr.appeal_decision,
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
      created_at: r.created_at, confirmed_at: r.confirmed_at,
      appeal_decision: r.appeal_decision
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

  // ---- POST /performance/records/:employee_id/:period/appeal-decision 申诉裁决 ----
  app.post('/performance/records/:employee_id/:period/appeal-decision', preAuth, async (req, reply) => {
    const empId = Number(req.params.employee_id);
    const period = req.params.period;
    if (!Number.isInteger(empId) || empId <= 0) {
      return reply.code(400).send({ ok: false, error: 'employee_id 需为正整数' });
    }
    const { decision, note } = req.body || {};
    if (!decision) {
      return reply.code(400).send({ ok: false, error: '需要 decision(upheld/overturned)' });
    }
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'confirm', empId)) {
      return reply.code(403).send({ ok: false, error: '无绩效裁决权限' });
    }
    try {
      const record = perf.decideAppeal(app.db, empId, period, {
        decision, note, decidedBy: req.principal.employee_id
      });
      return reply.send({ ok: true, record });
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes('考核记录不存在')) {
        return reply.code(404).send({ ok: false, error: '考核记录不存在' });
      }
      if (msg.includes('仅申诉状态')) {
        return reply.code(409).send({ ok: false, error: msg });
      }
      if (msg.includes('decision 需为')) {
        return reply.code(400).send({ ok: false, error: msg });
      }
      throw e;
    }
  });

  // ---- GET /performance/records/export 评分导出(CSV) ----
  app.get('/performance/records/export', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    const q = req.query || {};
    const where = [];
    const params = [];
    if (q.employee_id) { where.push('pr.employee_id = ?'); params.push(Number(q.employee_id)); }
    if (q.period) { where.push('pr.period = ?'); params.push(q.period); }
    if (q.status) { where.push('pr.status = ?'); params.push(q.status); }
    if (q.grade) { where.push('pr.grade = ?'); params.push(q.grade); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = app.db.prepare(
      `SELECT pr.employee_id, pr.period, pr.total_score, pr.grade, pr.status,
              e.name AS emp_name, e.position, e.department
         FROM performance_record pr
         LEFT JOIN employees e ON e.employee_id = pr.employee_id
         ${whereSql}
         ORDER BY pr.period DESC, pr.employee_id`
    ).all(...params);

    const header = 'employee_id,emp_name,position,department,period,total_score,grade,status';
    const lines = rows.map(r =>
      [r.employee_id, r.emp_name || '', r.position || '', r.department || '',
       r.period, r.total_score, r.grade, r.status].join(',')
    );
    const csv = '﻿' + [header, ...lines].join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="performance_export.csv"');
    return reply.send(csv);
  });

  // ---- POST /performance/rewards 奖惩录入 ----
  app.post('/performance/rewards', preAuth, async (req, reply) => {
    const { employee_id, type, score, reason, date } = req.body || {};
    if (!employee_id) {
      return reply.code(400).send({ ok: false, error: '需要 employee_id' });
    }
    const empId = Number(employee_id);
    if (!Number.isInteger(empId) || empId <= 0) {
      return reply.code(400).send({ ok: false, error: 'employee_id 需为正整数' });
    }
    if (!['reward', 'penalty'].includes(type)) {
      return reply.code(400).send({ ok: false, error: 'type 需为 reward/penalty' });
    }
    const scoreNum = Number(score);
    if (!Number.isInteger(scoreNum)) {
      return reply.code(400).send({ ok: false, error: 'score 需为整数' });
    }
    // 奖励为正、处罚为负,符号与类型一致
    if ((type === 'reward' && scoreNum <= 0) || (type === 'penalty' && scoreNum >= 0)) {
      return reply.code(400).send({ ok: false, error: '奖励需正分,处罚需负分' });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ ok: false, error: 'date 需为 YYYY-MM-DD' });
    }
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'save', empId)) {
      return reply.code(403).send({ ok: false, error: '无奖惩录入权限' });
    }
    const info = app.db.prepare(
      `INSERT INTO reward_penalty (employee_id, type, score, reason, date, approved_by)
       VALUES (?,?,?,?,?,?)`
    ).run(empId, type, scoreNum, reason || null, date, req.principal.employee_id);
    return reply.code(201).send({ ok: true, id: info.lastInsertRowid });
  });

  // ---- GET /performance/rewards 奖惩查询 ----
  app.get('/performance/rewards', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    if (q.employee_id) { where.push('rp.employee_id = ?'); params.push(Number(q.employee_id)); }
    if (q.type) { where.push('rp.type = ?'); params.push(q.type); }
    if (q.date) { where.push('rp.date = ?'); params.push(q.date); }
    const periodFilter = q.period;
    if (periodFilter) { where.push('rp.date LIKE ?'); params.push(periodFilter + '-%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = app.db.prepare(
      `SELECT COUNT(*) AS c FROM reward_penalty rp ${whereSql}`
    ).get(...params).c;
    const rows = app.db.prepare(
      `SELECT rp.id, rp.employee_id, rp.type, rp.score, rp.reason, rp.date,
              rp.approved_by, rp.created_at,
              e.name AS emp_name
         FROM reward_penalty rp
         LEFT JOIN employees e ON e.employee_id = rp.employee_id
         ${whereSql}
         ORDER BY rp.date DESC, rp.id DESC
         LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    const items = rows.map(r => ({
      id: r.id, employee_id: r.employee_id, emp_name: r.emp_name,
      type: r.type, score: r.score, reason: r.reason, date: r.date,
      approved_by: r.approved_by, created_at: r.created_at
    }));

    return reply.send({ ok: true, page, limit, total, pages: Math.ceil(total / limit), items });
  });

  // ---- GET /performance/dashboard 绩效看板 ----
  app.get('/performance/dashboard', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'performance', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无绩效查看权限' });
    }
    const q = req.query || {};
    const period = q.period || null;

    const where = [];
    const params = [];
    if (period) { where.push('pr.period = ?'); params.push(period); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // 等级分布
    const gradeRows = app.db.prepare(
      `SELECT pr.grade, COUNT(*) AS n
         FROM performance_record pr ${whereSql}
         GROUP BY pr.grade`
    ).all(...params);
    const grade_distribution = {};
    for (const g of ['S', 'A', 'B', 'C', 'D']) grade_distribution[g] = 0;
    for (const r of gradeRows) grade_distribution[r.grade] = Number(r.n);

    // 平均分
    const avgRow = app.db.prepare(
      `SELECT AVG(pr.total_score) AS avg_score, COUNT(*) AS n
         FROM performance_record pr ${whereSql}`
    ).get(...params);

    // 按部门聚合
    const deptRows = app.db.prepare(
      `SELECT e.department AS department, COUNT(*) AS n, AVG(pr.total_score) AS avg_score
         FROM performance_record pr
         LEFT JOIN employees e ON e.employee_id = pr.employee_id
         ${whereSql}
         GROUP BY e.department
         ORDER BY avg_score DESC`
    ).all(...params);

    // 按岗位聚合
    const posRows = app.db.prepare(
      `SELECT e.position AS position, COUNT(*) AS n, AVG(pr.total_score) AS avg_score
         FROM performance_record pr
         LEFT JOIN employees e ON e.employee_id = pr.employee_id
         ${whereSql}
         GROUP BY e.position
         ORDER BY avg_score DESC`
    ).all(...params);

    // 状态统计
    const statusRows = app.db.prepare(
      `SELECT pr.status, COUNT(*) AS n
         FROM performance_record pr ${whereSql}
         GROUP BY pr.status`
    ).all(...params);
    const status_distribution = {};
    for (const s of ['draft', 'confirmed', 'appealed']) status_distribution[s] = 0;
    for (const r of statusRows) status_distribution[r.status] = Number(r.n);

    return reply.send({
      ok: true,
      period: period || null,
      total: avgRow.n || 0,
      avg_score: avgRow.avg_score ? Math.round(avgRow.avg_score * 10) / 10 : null,
      grade_distribution,
      status_distribution,
      by_department: deptRows,
      by_position: posRows
    });
  });
}

module.exports = { registerPerformanceRoutes };
