// p2-t01.test.js — P2-T01 绩效评分引擎
// 验收:
//   ① 四维度公式(出勤/质量/任务/安全)逐条对齐 §十.6
//   ② 岗位加权 + 总分归一化(协作暂缓,不计入)
//   ③ 等级门槛 S/A/B/C/D 边界
//   ④ 未知岗位回退保洁员
//   ⑤ 考核结果落库/查询可追溯

const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('./db');
const {
  WEIGHT_PROFILES, gradeOf, getWeightProfile,
  calcAttendance, calcQuality, calcTask, calcSafety,
  calculatePerformance, savePerformanceRecord, getPerformanceRecord
} = require('./performance');

// ---- 内存库 fixture(迁移自动跑,含 011 绩效表) ----
function newDb() {
  const { db } = initDb(':memory:');
  return db;
}
function addEmp(db, id, position, name = `员工${id}`, department = '测试部') {
  db.prepare(
    `INSERT INTO employees (employee_id, name, position, department, is_active)
     VALUES (?,?,?,?,1)`
  ).run(id, name, position, department);
}
const D = '2026-10';                       // 考核周期
const d = (day) => `2026-10-${String(day).padStart(2, '0')}`;  // 周期内日期

function addAttendance(db, empId, date, status) {
  db.prepare(
    `INSERT INTO attendance_record (employee_id, date, status) VALUES (?,?,?)`
  ).run(empId, date, status);
}
function addTask(db, empId, title, dueDate, status, completedDate = null) {
  db.prepare(
    `INSERT INTO task_assignment (employee_id, title, due_date, status, completed_date)
     VALUES (?,?,?,?,?)`
  ).run(empId, title, dueDate, status, completedDate);
}
function addQuality(db, empId, date, score) {
  db.prepare(
    `INSERT INTO quality_check (employee_id, date, score) VALUES (?,?,?)`
  ).run(empId, date, score);
}
function addRP(db, empId, type, score, date) {
  db.prepare(
    `INSERT INTO reward_penalty (employee_id, type, score, date) VALUES (?,?,?,?)`
  ).run(empId, type, score, date);
}

// ============ ① 出勤维度 ============

test('出勤:迟到/缺勤/请假按系数扣分,下限 0', () => {
  const db = newDb();
  addEmp(db, 1, '司机');
  addAttendance(db, 1, d(1), '迟到');
  addAttendance(db, 1, d(2), '迟到');
  addAttendance(db, 1, d(3), '缺勤');
  addAttendance(db, 1, d(4), '请假');
  addAttendance(db, 1, d(5), '正常');
  const r = calcAttendance(db, 1, D);
  // 100 - 2*5 - 1*20 - 1*10 = 60
  assert.equal(r.score, 60);
  assert.equal(r.detail.late, 2);
  assert.equal(r.detail.absent, 1);
  assert.equal(r.detail.leave, 1);
  assert.equal(r.detail.fullDays, 1);
});

test('出勤:无记录→满分 100', () => {
  const db = newDb();
  addEmp(db, 2, '司机');
  assert.equal(calcAttendance(db, 2, D).score, 100);
});

test('出勤:扣分封底 0', () => {
  const db = newDb();
  addEmp(db, 3, '司机');
  for (let i = 0; i < 10; i++) addAttendance(db, 3, d(i + 1), '缺勤');  // 10*20=200 → 封底
  assert.equal(calcAttendance(db, 3, D).score, 0);
});

// ============ ② 作业质量维度 ============

test('质量:多条质检取平均分', () => {
  const db = newDb();
  addEmp(db, 4, '保洁员');
  addQuality(db, 4, d(1), 90);
  addQuality(db, 4, d(2), 80);
  const r = calcQuality(db, 4, D);
  assert.equal(r.score, 85);
  assert.equal(r.detail.inspections, 2);
});

test('质量:无质检→默认 80', () => {
  const db = newDb();
  addEmp(db, 5, '保洁员');
  assert.equal(calcQuality(db, 5, D).score, 80);
});

// ============ ③ 任务完成维度 ============

test('任务:按时率 = 按时完成 / 分配数', () => {
  const db = newDb();
  addEmp(db, 6, '司机');
  addTask(db, 6, 't1', d(10), '已完成', d(9));    // 按时
  addTask(db, 6, 't2', d(11), '已完成', d(11));    // 按时(等于截止日)
  addTask(db, 6, 't3', d(12), '已完成', d(13));    // 晚完成,不计按时
  addTask(db, 6, 't4', d(13), '进行中');           // 未完成
  const r = calcTask(db, 6, D);
  assert.equal(r.detail.assigned, 4);
  assert.equal(r.detail.completed, 3);
  assert.equal(r.detail.onTime, 2);
  assert.equal(r.score, Math.round((2 / 4) * 100));  // 50
});

test('任务:无任务→默认 80', () => {
  const db = newDb();
  addEmp(db, 7, '司机');
  assert.equal(calcTask(db, 7, D).score, 80);
});

// ============ ④ 安全合规维度 ============

test('安全:奖惩加减,区间 [0,120]', () => {
  const db = newDb();
  addEmp(db, 8, '司机');
  addRP(db, 8, 'reward', 10, d(1));
  addRP(db, 8, 'penalty', -15, d(2));
  const r = calcSafety(db, 8, D);
  assert.equal(r.score, 95);   // 100 + 10 - 15
});

test('安全:奖分封顶 120', () => {
  const db = newDb();
  addEmp(db, 9, '司机');
  addRP(db, 9, 'reward', 10, d(1));
  addRP(db, 9, 'reward', 10, d(2));
  addRP(db, 9, 'reward', 10, d(3));
  assert.equal(calcSafety(db, 9, D).score, 120);   // 100+30 → 封顶 120
});

test('安全:罚分封底 0', () => {
  const db = newDb();
  addEmp(db, 10, '司机');
  for (let i = 0; i < 7; i++) addRP(db, 10, 'penalty', -20, d(i + 1));  // 100-140 → 封底
  assert.equal(calcSafety(db, 10, D).score, 0);
});

// ============ ⑤ 岗位加权 + 总分归一化 ============

test('加权:司机四维度加权,协作暂缓不计入', () => {
  const db = newDb();
  addEmp(db, 11, '司机');
  addAttendance(db, 11, d(1), '迟到');          // 出勤 95
  addQuality(db, 11, d(2), 90);                 // 质量 90
  addTask(db, 11, 't1', d(10), '已完成', d(9)); // 任务 100
  addTask(db, 11, 't2', d(11), '进行中');        // 任务:按时 1/2 → 50... 见下
  const r = calculatePerformance(db, 11, D);
  // 出勤95*20 + 质量90*20 + 任务50*30 + 安全100*25 = 1900+1800+1500+2500 = 7700
  // 启用权重和 = 20+20+30+25 = 95 → 7700/95 = 81.0526 → 81.1, 等级 B
  assert.equal(r.scores.attendance.score, 95);
  assert.equal(r.scores.quality.score, 90);
  assert.equal(r.scores.task.score, 50);
  assert.equal(r.scores.safety.score, 100);
  assert.equal(r.scores.collaboration, null);     // 协作暂缓
  assert.deepEqual(r.deferred_dimensions, ['collaboration']);
  assert.equal(r.weights.attendance, 20);
  assert.equal(r.total_score, 81.1);
  assert.equal(r.grade, 'B');
});

test('加权:全满分员工→总分 100,S 级', () => {
  const db = newDb();
  addEmp(db, 12, '保洁员');
  // 无考勤记录→100,无质检→80,无任务→80,无奖惩→100 → 见下方独立断言
  const r = calculatePerformance(db, 12, D);
  // (100*25 + 80*35 + 80*25 + 100*10)/95 = 8300/95 = 87.368 → 87.4, A
  assert.equal(r.total_score, 87.4);
  assert.equal(r.grade, 'A');
});

// ============ ⑥ 等级门槛边界 ============

test('等级:S/A/B/C/D 边界', () => {
  assert.equal(gradeOf(100), 'S');
  assert.equal(gradeOf(95), 'S');
  assert.equal(gradeOf(94.99), 'A');
  assert.equal(gradeOf(85), 'A');
  assert.equal(gradeOf(84.99), 'B');
  assert.equal(gradeOf(75), 'B');
  assert.equal(gradeOf(74.99), 'C');
  assert.equal(gradeOf(60), 'C');
  assert.equal(gradeOf(59.99), 'D');
  assert.equal(gradeOf(0), 'D');
});

// ============ ⑦ 岗位权重表 + 未知岗位回退 ============

test('权重表:五岗位权重和=100', () => {
  for (const [pos, w] of Object.entries(WEIGHT_PROFILES)) {
    const sum = Object.values(w).reduce((s, v) => s + v, 0);
    assert.equal(sum, 100, `${pos} 权重和应为 100`);
  }
});

test('未知岗位回退保洁员权重', () => {
  const w = getWeightProfile('不存在岗位');
  assert.deepEqual(w, WEIGHT_PROFILES['保洁员']);
});

// ============ ⑧ 员工不存在报错 ============

test('员工不存在:抛错', () => {
  const db = newDb();
  assert.throws(() => calculatePerformance(db, 9999, D), /员工不存在/);
});

// ============ ⑨ 考核结果落库/查询 ============

test('落库:保存后可按员工+周期查回', () => {
  const db = newDb();
  addEmp(db, 13, '司机');
  addAttendance(db, 13, d(1), '正常');
  const r = calculatePerformance(db, 13, D);
  const id = savePerformanceRecord(db, r, { status: 'confirmed', comment: '表现良好', comment_by: '主管' });
  const row = getPerformanceRecord(db, 13, D);
  assert.equal(row.id, id);
  assert.equal(row.employee_id, 13);
  assert.equal(row.period, D);
  assert.equal(row.grade, r.grade);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.comment, '表现良好');
  const scores = JSON.parse(row.scores_json);
  assert.equal(scores.attendance.score, 100);
  assert.equal(scores.collaboration, null);
});

test('落库:同员工同周期重复保存被唯一约束拦截', () => {
  const db = newDb();
  addEmp(db, 14, '司机');
  const r = calculatePerformance(db, 14, D);
  savePerformanceRecord(db, r);
  assert.throws(() => savePerformanceRecord(db, r), /UNIQUE|constraint/i);
});
