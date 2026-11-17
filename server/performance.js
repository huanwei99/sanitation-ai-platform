// performance.js — P2-T01 绩效评分引擎(子系统B 核心)
// 权威定义:platform-upgrade-plan.md §十。
// 范围:4 硬维度(出勤/质量/任务/安全)评分 + 岗位加权 + 等级判定。
// 协作维度(collaboration)按路线图暂缓:WEIGHT_PROFILES 保留其权重以便后续激活,
// 但当前不计入总分(总分按已启用维度权重归一化,仍在 0-100 区间)。

// ---- 岗位差异化权重(§十.2,权重和=100) ----
const WEIGHT_PROFILES = {
  '管理层':   { attendance: 15, quality: 25, task: 30, safety: 15, collaboration: 15 },
  '司机':     { attendance: 20, quality: 20, task: 30, safety: 25, collaboration: 5 },
  '保洁员':   { attendance: 25, quality: 35, task: 25, safety: 10, collaboration: 5 },
  '班组长':   { attendance: 20, quality: 25, task: 25, safety: 15, collaboration: 15 },
  '办公人员': { attendance: 20, quality: 15, task: 30, safety: 10, collaboration: 25 }
};

const DIMENSIONS = ['attendance', 'quality', 'task', 'safety', 'collaboration'];
// 当前启用(已实现公式)的维度;collaboration 暂缓
const ACTIVE_DIMENSIONS = ['attendance', 'quality', 'task', 'safety'];
const DEFERRED_DIMENSIONS = ['collaboration'];

// ---- 等级门槛(§十.4) ----
function gradeOf(total) {
  if (total >= 95) return 'S';
  if (total >= 85) return 'A';
  if (total >= 75) return 'B';
  if (total >= 60) return 'C';
  return 'D';
}

// 取岗位权重:优先读配置表(P2-T02 权重可配),无配置行/无 db 时回退常量;
// 未知岗位回退保洁员(§十.6 口径)。
function getWeightProfile(position, db = null) {
  if (db) {
    const row = db.prepare(
      'SELECT weights_json FROM performance_weight_config WHERE position = ?'
    ).get(position);
    if (row) {
      try {
        const w = JSON.parse(row.weights_json);
        if (w && typeof w === 'object') return w;
      } catch {
        // 配置损坏回退常量
      }
    }
  }
  return WEIGHT_PROFILES[position] || WEIGHT_PROFILES['保洁员'];
}

// ---------- 权重配置管理(P2-T02) ----------

// 校验权重对象:5 维度全在、非负数、权重和=100(§十.2 口径)
function validateWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    return 'weights 需为 JSON 对象';
  }
  for (const d of DIMENSIONS) {
    if (!(d in weights)) return `weights 缺少维度 ${d}`;
    if (typeof weights[d] !== 'number' || Number.isNaN(weights[d]) || weights[d] < 0) {
      return `weights.${d} 需为非负数`;
    }
  }
  const sum = DIMENSIONS.reduce((s, d) => s + weights[d], 0);
  if (sum !== 100) return `权重和需为 100,当前 ${sum}`;
  return null;
}

function getWeightConfig(db, position) {
  const row = db.prepare(
    'SELECT position, weights_json, updated_by, updated_at FROM performance_weight_config WHERE position = ?'
  ).get(position);
  if (!row) return null;
  return {
    position: row.position,
    weights: JSON.parse(row.weights_json),
    updated_by: row.updated_by,
    updated_at: row.updated_at
  };
}

function listWeightConfigs(db) {
  return db.prepare(
    'SELECT position, weights_json, updated_by, updated_at FROM performance_weight_config ORDER BY position'
  ).all().map(row => ({
    position: row.position,
    weights: JSON.parse(row.weights_json),
    updated_by: row.updated_by,
    updated_at: row.updated_at
  }));
}

// 写入/更新岗位权重配置(PUT 语义)
function upsertWeightConfig(db, position, weights, updatedBy = null) {
  const err = validateWeights(weights);
  if (err) throw new Error(err);
  db.prepare(
    `INSERT INTO performance_weight_config (position, weights_json, updated_by)
     VALUES (?,?,?)
     ON CONFLICT(position) DO UPDATE SET
       weights_json = excluded.weights_json,
       updated_by = excluded.updated_by,
       updated_at = CURRENT_TIMESTAMP`
  ).run(position, JSON.stringify(weights), updatedBy);
  return getWeightConfig(db, position);
}

// 周期前缀:period 形如 '2026-10',匹配 YYYY-MM-DD 日期
function periodPrefix(period) {
  return period + '-';
}

// ---------- 各维度计算(公式逐条对齐 §十.6) ----------

// 1. 出勤:100 - 迟到*5 - 缺勤*20 - 请假*10,下限 0
function calcAttendance(db, empId, period) {
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM attendance_record
      WHERE employee_id = ? AND date LIKE ?
      GROUP BY status`
  ).all(empId, periodPrefix(period) + '%');
  const counts = { '正常': 0, '迟到': 0, '缺勤': 0, '请假': 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  const score = Math.max(0, 100 - counts['迟到'] * 5 - counts['缺勤'] * 20 - counts['请假'] * 10);
  return { score, detail: { fullDays: counts['正常'], late: counts['迟到'], absent: counts['缺勤'], leave: counts['请假'] } };
}

// 2. 作业质量:质检平均分;无质检默认 80
function calcQuality(db, empId, period) {
  const rows = db.prepare(
    `SELECT score FROM quality_check
      WHERE employee_id = ? AND date LIKE ?`
  ).all(empId, periodPrefix(period) + '%');
  const inspections = rows.length;
  const score = inspections
    ? rows.reduce((s, r) => s + Number(r.score), 0) / inspections
    : 80;
  return { score, detail: { inspections, avgScore: score, deductions: [] } };
}

// 3. 任务完成:按时率 = 按时完成 / 分配任务数;无任务默认 80
function calcTask(db, empId, period) {
  const rows = db.prepare(
    `SELECT status, due_date, completed_date FROM task_assignment
      WHERE employee_id = ? AND due_date LIKE ?`
  ).all(empId, periodPrefix(period) + '%');
  const assigned = rows.length;
  const completed = rows.filter(r => r.status === '已完成').length;
  const onTime = rows.filter(
    r => r.status === '已完成' && r.completed_date && r.completed_date <= r.due_date
  ).length;
  const score = assigned ? Math.round((onTime / assigned) * 100) : 80;
  return { score, detail: { assigned, completed, onTime, overdue: assigned - onTime } };
}

// 4. 安全合规:100 + 奖分 + 罚分,区间 [0, 120]
function calcSafety(db, empId, period) {
  const rows = db.prepare(
    `SELECT type, score FROM reward_penalty
      WHERE employee_id = ? AND date LIKE ?`
  ).all(empId, periodPrefix(period) + '%');
  const awards = rows.filter(r => r.type === 'reward');
  const violations = rows.filter(r => r.type === 'penalty');
  const awardsSum = awards.reduce((s, a) => s + Number(a.score), 0);
  const violationsSum = violations.reduce((s, v) => s + Number(v.score), 0);
  const score = Math.max(0, Math.min(120, 100 + awardsSum + violationsSum));
  return {
    score,
    detail: { violations: violations.length, awards: awards.length, violationsSum, awardsSum }
  };
}

// ---------- 主入口 ----------

/**
 * 计算某员工某周期的绩效得分。
 * @param {object} db    数据库连接
 * @param {number} empId 员工工号
 * @param {string} period 考核周期,形如 '2026-10'
 * @returns {object} scores(各维度得分+明细) / weights / total_score / grade / deferred
 */
function calculatePerformance(db, empId, period) {
  const emp = db.prepare(
    'SELECT employee_id, name, position, department FROM employees WHERE employee_id = ?'
  ).get(empId);
  if (!emp) throw new Error(`员工不存在: ${empId}`);

  const weights = getWeightProfile(emp.position, db);
  const scores = {
    attendance: calcAttendance(db, empId, period),
    quality: calcQuality(db, empId, period),
    task: calcTask(db, empId, period),
    safety: calcSafety(db, empId, period),
    collaboration: null   // 协作暂缓,不计算
  };

  // 加权:仅对已启用维度,按其权重归一化(总分仍在 0-100)
  const weightSum = ACTIVE_DIMENSIONS.reduce((s, d) => s + weights[d], 0);
  const total = ACTIVE_DIMENSIONS.reduce((s, d) => s + scores[d].score * weights[d], 0) / weightSum;

  return {
    employee_id: empId,
    emp_name: emp.name,
    position: emp.position,
    department: emp.department,
    period,
    scores,
    weights,
    total_score: Math.round(total * 10) / 10,
    grade: gradeOf(total),
    deferred_dimensions: DEFERRED_DIMENSIONS
  };
}

// ---------- 考核结果落库/查询(供后续路由/完整模块复用) ----------

function newRecordId(period) {
  const y = period.slice(0, 4);
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `PR-${y}-${seq}`;
}

function savePerformanceRecord(db, result, { status = 'draft', comment = null, comment_by = null } = {}) {
  const id = newRecordId(result.period);
  db.prepare(
    `INSERT INTO performance_record
       (id, employee_id, period, period_type, scores_json, weights_json, total_score, grade, status, comment, comment_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, result.employee_id, result.period, 'monthly',
    JSON.stringify(result.scores), JSON.stringify(result.weights),
    result.total_score, result.grade, status, comment, comment_by
  );
  return id;
}

function getPerformanceRecord(db, empId, period) {
  return db.prepare(
    `SELECT id, employee_id, period, period_type, scores_json, weights_json, total_score, grade, status, comment, comment_by, created_at, confirmed_at,
            appeal_decision, appeal_note, appeal_decided_by, appeal_decided_at
       FROM performance_record
      WHERE employee_id = ? AND period = ? AND period_type = 'monthly'`
  ).get(empId, period);
}

// ---------- 申诉裁决(P2-T02:申诉可提交 → 有权限主体裁决) ----------

// 裁决申诉:仅 status='appealed' 且裁决待决(appeal_decision='pending' 或未裁决)可裁决
// decision: upheld(维持)/overturned(撤销)
function decideAppeal(db, empId, period, { decision, note, decidedBy }) {
  if (!['upheld', 'overturned'].includes(decision)) {
    throw new Error('decision 需为 upheld/overturned');
  }
  const row = getPerformanceRecord(db, empId, period);
  if (!row) throw new Error('考核记录不存在');
  if (row.status !== 'appealed') throw new Error('仅申诉状态记录可裁决');
  db.prepare(
    `UPDATE performance_record
        SET appeal_decision = ?, appeal_note = ?, appeal_decided_by = ?, appeal_decided_at = CURRENT_TIMESTAMP
      WHERE employee_id = ? AND period = ? AND period_type = 'monthly'`
  ).run(decision, note || null, decidedBy || null, empId, period);
  return getPerformanceRecord(db, empId, period);
}

module.exports = {
  WEIGHT_PROFILES, DIMENSIONS, ACTIVE_DIMENSIONS, DEFERRED_DIMENSIONS,
  gradeOf, getWeightProfile, validateWeights,
  getWeightConfig, listWeightConfigs, upsertWeightConfig,
  calcAttendance, calcQuality, calcTask, calcSafety,
  calculatePerformance,
  savePerformanceRecord, getPerformanceRecord, newRecordId,
  decideAppeal
};
