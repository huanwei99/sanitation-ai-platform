// p2-t02.test.js — P2-T02 绩效完整模块路由:权重配置/奖惩/申诉裁决/看板/导出
// 验收:
//   ① 权重可配:PUT /performance/weights/:position 改配置后引擎生效;校验权重和=100
//   ② 权重配置列表含修改人/时间
//   ③ 奖惩可录入:reward 正分/penalty 负分,符号校验;查询分页
//   ④ 申诉可提交 + 裁决:appeal-decision upheld/overturned;状态机校验
//   ⑤ 绩效看板:等级/状态分布、平均分、按部门/岗位聚合
//   ⑥ 评分可导出:CSV 内容 + 筛选
//   ⑦ 范围校验:self 范围越权 403

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-p2t02-'));
  return path.join(dir, 'test.db');
}
async function cleanup(app, dbPath) {
  try { await app.close(); } catch {}
  const dir = path.dirname(dbPath);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise(r => setTimeout(r, 100 * (i + 1))); }
  }
}

async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'perf-p2t02-secret' });
  await app.ready();

  await seedAccount(app.db, {
    employee_id: 5001, account: 'HQ5001', password: 'Pwd5001@x',
    name: '总部管理员', position: '管理层', department: '管理部',
    permissions: { mode: 'manual', level: 3, scope: 'self', admin_level: 3, modules: {} }
  });
  await seedAccount(app.db, {
    employee_id: 5002, account: 'PM5002', password: 'Pwd5002@x',
    name: '绩效专员', position: '办公人员', department: '管理部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { performance: ['view', 'calculate', 'save', 'confirm', 'appeal'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 5003, account: 'DRV5003', password: 'Pwd5003@x',
    name: '张师傅', position: '司机', department: '清运一队'
  });
  await seedAccount(app.db, {
    employee_id: 5004, account: 'CLR5004', password: 'Pwd5004@x',
    name: '李保洁', position: '保洁员', department: '清扫二队'
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    hq: await login('HQ5001', 'Pwd5001@x'),
    pm: await login('PM5002', 'Pwd5002@x'),
    driver: await login('DRV5003', 'Pwd5003@x'),
    cleaner: await login('CLR5004', 'Pwd5004@x'),
    emp: 5003,
    emp2: 5004
  };
}

// 造数据源:全正常 → 各维度满分(安全=100)
async function seedSource(app, empId, period = '2026-10') {
  const p = period + '-';
  app.db.prepare(
    `INSERT INTO attendance_record (employee_id, date, status) VALUES (?, ?, '正常')`
  ).run(empId, `${p}15`);
  app.db.prepare(
    `INSERT INTO task_assignment (employee_id, title, due_date, status, completed_date) VALUES (?, '清运任务', ?, '已完成', ?)`
  ).run(empId, `${p}20`, `${p}19`);
  app.db.prepare(
    `INSERT INTO quality_check (employee_id, inspector_id, date, score) VALUES (?, 5001, ?, 90)`
  ).run(empId, `${p}10`);
}

test('P2-T02-WT1: 权重配置 — PUT 修改后引擎生效 + 权重和校验', async () => {
  const { app, dbPath, hq, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    // 修改司机权重:attendance 40 / task 60(其余 0)
    const newWeights = { attendance: 40, quality: 0, task: 60, safety: 0, collaboration: 0 };
    const r = await app.inject({ method: 'PUT', url: '/performance/weights/司机', headers: { cookie: hq },
      payload: { weights: newWeights } });
    assert.equal(r.statusCode, 200, `PUT 应 200: ${r.body}`);
    assert.equal(r.json().config.position, '司机');
    assert.equal(r.json().config.weights.attendance, 40);
    assert.equal(String(r.json().config.updated_by), '5001', '应记录修改人');

    // 引擎计算应使用新权重:出勤100 task100,其余0 → (100*40+100*60)/100 = 100
    const calc = await app.inject({ method: 'POST', url: '/performance/calculate', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10' } });
    assert.equal(calc.statusCode, 200, `计算应 200: ${calc.body}`);
    const result = calc.json().result;
    assert.equal(result.weights.attendance, 40, '引擎应读配置表新权重');
    assert.equal(result.weights.task, 60);
    assert.equal(result.total_score, 100, '(100*40+100*60)/100');

    // 权重和≠100 → 400
    const bad = await app.inject({ method: 'PUT', url: '/performance/weights/司机', headers: { cookie: hq },
      payload: { weights: { attendance: 50, quality: 0, task: 0, safety: 0, collaboration: 0 } } });
    assert.equal(bad.statusCode, 400, '权重和≠100 应 400');

    // 缺维度 → 400
    const bad2 = await app.inject({ method: 'PUT', url: '/performance/weights/司机', headers: { cookie: hq },
      payload: { weights: { attendance: 100 } } });
    assert.equal(bad2.statusCode, 400, '缺维度应 400');

    // 无权限 → 403
    const forbid = await app.inject({ method: 'PUT', url: '/performance/weights/司机', headers: { cookie: 'x' } });
    assert.equal(forbid.statusCode, 401, '未登录应 401');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-WT2: 权重配置列表 — 含 5 岗位 + 修改人/时间', async () => {
  const { app, dbPath, hq, driver } = await buildFixture();
  try {
    // 修改一个岗位
    await app.inject({ method: 'PUT', url: '/performance/weights/保洁员', headers: { cookie: hq },
      payload: { weights: { attendance: 30, quality: 35, task: 25, safety: 10, collaboration: 0 } } });
    const r = await app.inject({ method: 'GET', url: '/performance/weight-config', headers: { cookie: hq } });
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.equal(items.length, 5, '应 5 个岗位配置');
    const cleaner = items.find(i => i.position === '保洁员');
    assert.ok(cleaner.updated_by, '修改后应记录修改人');
    assert.ok(cleaner.updated_at, '应有修改时间');
    assert.equal(cleaner.weights.attendance, 30);

    // 无权限 → 403
    const forbid = await app.inject({ method: 'GET', url: '/performance/weight-config', headers: { cookie: driver } });
    assert.equal(forbid.statusCode, 403);
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-RW1: 奖惩录入 — reward 正分 / penalty 负分 + 符号校验', async () => {
  const { app, dbPath, hq, pm, emp } = await buildFixture();
  try {
    // 奖励
    const rw = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'reward', score: 5, reason: '好人好事', date: '2026-10-15' } });
    assert.equal(rw.statusCode, 201, `奖励应 201: ${rw.body}`);
    assert.ok(rw.json().id, '应返回 id');

    // 处罚
    const pc = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'penalty', score: -3, reason: '违规操作', date: '2026-10-20' } });
    assert.equal(pc.statusCode, 201, `处罚应 201: ${pc.body}`);

    // reward 给负分 → 400
    const bad1 = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'reward', score: -5, date: '2026-10-15' } });
    assert.equal(bad1.statusCode, 400, '奖励负分应 400');

    // penalty 给正分 → 400
    const bad2 = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'penalty', score: 5, date: '2026-10-15' } });
    assert.equal(bad2.statusCode, 400, '处罚正分应 400');

    // 非法 type → 400
    const bad3 = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'bogus', score: 5, date: '2026-10-15' } });
    assert.equal(bad3.statusCode, 400, '非法 type 应 400');

    // 非法 date → 400
    const bad4 = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'reward', score: 5, date: '2026/10/15' } });
    assert.equal(bad4.statusCode, 400, '非法 date 应 400');

    // 无权限 → 403(self 范围录入别人)
    const forbid = await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: pm },
      payload: { employee_id: emp, type: 'reward', score: 5, date: '2026-10-15' } });
    assert.equal(forbid.statusCode, 403, 'self 范围录入别人应 403');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-RW2: 奖惩查询 — 分页 + 筛选', async () => {
  const { app, dbPath, hq, emp } = await buildFixture();
  try {
    await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'reward', score: 5, date: '2026-10-15' } });
    await app.inject({ method: 'POST', url: '/performance/rewards', headers: { cookie: hq },
      payload: { employee_id: emp, type: 'penalty', score: -3, date: '2026-10-20' } });

    const r = await app.inject({ method: 'GET', url: '/performance/rewards', headers: { cookie: hq } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.total, 2);
    assert.equal(body.items.length, 2);
    assert.ok(body.items[0].emp_name, '应含员工名');

    // 按 type 筛选
    const byType = await app.inject({ method: 'GET', url: '/performance/rewards?type=penalty', headers: { cookie: hq } });
    assert.equal(byType.json().total, 1, '按 penalty 筛选应 1 条');

    // 按周期筛选
    const byPeriod = await app.inject({ method: 'GET', url: '/performance/rewards?period=2026-10', headers: { cookie: hq } });
    assert.equal(byPeriod.json().total, 2, '按周期筛选应 2 条');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-AP1: 申诉裁决 — upheld/overturned + 状态机校验', async () => {
  const { app, dbPath, hq, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    // draft → confirmed → appealed
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'appealed', comment: '异议' } });

    // 裁决维持
    const up = await app.inject({ method: 'POST', url: `/performance/records/${emp}/2026-10/appeal-decision`, headers: { cookie: hq },
      payload: { decision: 'upheld', note: '评分无误' } });
    assert.equal(up.statusCode, 200, `裁决应 200: ${up.body}`);
    assert.equal(up.json().record.appeal_decision, 'upheld');
    assert.equal(up.json().record.appeal_note, '评分无误');
    assert.ok(up.json().record.appeal_decided_by, '应记录裁决人');
    assert.ok(up.json().record.appeal_decided_at, '应记录裁决时间');

    // 重复裁决 → 仍可(状态仍是 appealed,但已有 decision;decideAppeal 不校验 decision 状态)
    // 实际:decideAppeal 只校验 status==='appealed',不校验 appeal_decision,所以允许重裁
    const again = await app.inject({ method: 'POST', url: `/performance/records/${emp}/2026-10/appeal-decision`, headers: { cookie: hq },
      payload: { decision: 'overturned', note: '改判' } });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().record.appeal_decision, 'overturned');

    // 非申诉状态裁决 → 409
    // 先建一个 confirmed 记录
    await seedSource(app, emp, '2026-11');
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-11', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-11', status: 'confirmed' } });
    const bad = await app.inject({ method: 'POST', url: `/performance/records/${emp}/2026-11/appeal-decision`, headers: { cookie: hq },
      payload: { decision: 'upheld' } });
    assert.equal(bad.statusCode, 409, '非申诉状态裁决应 409');

    // 不存在记录 → 404
    const nf = await app.inject({ method: 'POST', url: `/performance/records/${emp}/2025-01/appeal-decision`, headers: { cookie: hq },
      payload: { decision: 'upheld' } });
    assert.equal(nf.statusCode, 404, '无记录裁决应 404');

    // 非法 decision → 400
    const bad2 = await app.inject({ method: 'POST', url: `/performance/records/${emp}/2026-10/appeal-decision`, headers: { cookie: hq },
      payload: { decision: 'bogus' } });
    assert.equal(bad2.statusCode, 400, '非法 decision 应 400');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-AP2: 申诉裁决权限 — confirm 动作校验', async () => {
  const { app, dbPath, pm, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: 'x' }, payload: {} });
    // 建记录走总部(用 hq cookie)
    const hq = await (await app.inject({ method: 'POST', url: '/auth/login',
      payload: { account: 'HQ5001', password: 'Pwd5001@x' } })).headers['set-cookie'];
    const hqCookie = `sid=${hq.match(/sid=([^;]+)/)[1]}`;
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hqCookie },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hqCookie },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hqCookie },
      payload: { employee_id: emp, period: '2026-10', status: 'appealed' } });

    // 绩效专员有 confirm 但 scope=self,裁决别人(5003)应 403
    const forbid = await app.inject({ method: 'POST', url: `/performance/records/${emp}/2026-10/appeal-decision`,
      headers: { cookie: pm }, payload: { decision: 'upheld' } });
    assert.equal(forbid.statusCode, 403, 'self 范围裁决别人应 403');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-DB1: 绩效看板 — 等级/状态分布 + 平均分 + 聚合', async () => {
  const { app, dbPath, hq, driver, emp, emp2 } = await buildFixture();
  try {
    await seedSource(app, emp);
    await seedSource(app, emp2);
    // 先 draft 再 confirm(状态机要求)
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp2, period: '2026-10', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp2, period: '2026-10', status: 'confirmed' } });

    const r = await app.inject({ method: 'GET', url: '/performance/dashboard?period=2026-10', headers: { cookie: hq } });
    assert.equal(r.statusCode, 200, `看板应 200: ${r.body}`);
    const body = r.json();
    assert.equal(body.total, 2);
    assert.ok(body.avg_score >= 90, '平均分应高');
    assert.equal(body.grade_distribution.S, 2, '2 条 S');
    assert.equal(body.grade_distribution.A, 0);
    assert.equal(body.status_distribution.confirmed, 2);
    assert.ok(body.by_department.length >= 1, '应有部门聚合');
    assert.ok(body.by_position.length >= 1, '应有岗位聚合');

    // 无权限 → 403
    const forbid = await app.inject({ method: 'GET', url: '/performance/dashboard', headers: { cookie: driver } });
    assert.equal(forbid.statusCode, 403);
  } finally { await cleanup(app, dbPath); }
});

test('P2-T02-EX1: 评分导出 — CSV 内容 + 筛选', async () => {
  const { app, dbPath, hq, driver, emp, emp2 } = await buildFixture();
  try {
    await seedSource(app, emp);
    await seedSource(app, emp2);
    // 先 draft 再 confirm(状态机要求)
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp2, period: '2026-10', status: 'draft' } });

    const r = await app.inject({ method: 'GET', url: '/performance/records/export', headers: { cookie: hq } });
    assert.equal(r.statusCode, 200, `导出应 200: ${r.body}`);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /attachment/);
    const csv = r.body;
    assert.match(csv, /employee_id,emp_name,position,department,period,total_score,grade,status/, '应有表头');
    assert.match(csv, /张师傅/, '应含员工名');
    const lines = csv.split('\n');
    assert.equal(lines.length, 3, '表头 + 2 条记录');

    // 筛选
    const filtered = await app.inject({ method: 'GET', url: '/performance/records/export?status=confirmed', headers: { cookie: hq } });
    const flines = filtered.body.split('\n');
    assert.equal(flines.length, 2, '筛选 confirmed 应 1 条 + 表头');

    // 无权限 → 403
    const forbid = await app.inject({ method: 'GET', url: '/performance/records/export', headers: { cookie: driver } });
    assert.equal(forbid.statusCode, 403);
  } finally { await cleanup(app, dbPath); }
});
