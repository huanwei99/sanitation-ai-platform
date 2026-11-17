// performance-routes.test.js — P2-T01 绩效路由:权重/计算/落库状态机/查询
// 验收:
//   ① 权重画像 5 岗位
//   ② 纯计算(不落库)+ 无权限 403 + 员工不存在 404
//   ③ 落库状态机 draft→confirmed→appealed,非法转移 409,重复落库 409
//   ④ 分页查询 + 单条查询 + 范围校验(self 越权 403)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-route-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'perf-secret' });
  await app.ready();

  // 总部管理员(admin_level=3 放行全部)
  await seedAccount(app.db, {
    employee_id: 5001, account: 'HQ5001', password: 'Pwd5001@x',
    name: '总部管理员', position: '管理层', department: '管理部',
    permissions: { mode: 'manual', level: 3, scope: 'self', admin_level: 3, modules: {} }
  });
  // 绩效专员:performance 全操作,但范围 self(只能看自己)
  await seedAccount(app.db, {
    employee_id: 5002, account: 'PM5002', password: 'Pwd5002@x',
    name: '绩效专员', position: '办公人员', department: '管理部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { performance: ['view', 'calculate', 'save', 'confirm', 'appeal'] }, admin_level: 0 }
  });
  // 被考核员工(司机,无权限记录)
  await seedAccount(app.db, {
    employee_id: 5003, account: 'DRV5003', password: 'Pwd5003@x',
    name: '张师傅', position: '司机', department: '清运一队'
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
    // 被考核人(5003,司机)
    emp: 5003
  };
}

// 造数据源:司机 2026-10 全正常 → 各维度满分(安全=100)
async function seedSource(app, empId = 5003, period = '2026-10') {
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
  // 无奖惩 → 安全=100
}

test('P2-T01-RT1: 权重画像 — 5 岗位 + 等级门槛', async () => {
  const { app, dbPath, hq } = await buildFixture();
  try {
    const r = await app.inject({ method: 'GET', url: '/performance/weights', headers: { cookie: hq } });
    assert.equal(r.statusCode, 200, `权重应 200: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 5, '应 5 个岗位画像');
    const positions = body.items.map(i => i.position);
    assert.deepEqual(positions, ['管理层', '司机', '保洁员', '班组长', '办公人员']);
    for (const item of body.items) {
      const sum = Object.values(item.weights).reduce((s, w) => s + w, 0);
      assert.equal(sum, 100, `${item.position} 权重和应=100`);
      assert.deepEqual(item.deferred_dimensions, ['collaboration']);
    }
    assert.deepEqual(body.grade_thresholds, { S: 95, A: 85, B: 75, C: 60 });
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT2: 权重画像 — 无权限 403', async () => {
  const { app, dbPath, driver } = await buildFixture();
  try {
    const r = await app.inject({ method: 'GET', url: '/performance/weights', headers: { cookie: driver } });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().ok, false);
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT3: 纯计算 — 数据源满分口径正确,且不落库', async () => {
  const { app, dbPath, hq, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    const r = await app.inject({ method: 'POST', url: '/performance/calculate', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10' } });
    assert.equal(r.statusCode, 200, `计算应 200: ${r.body}`);
    const result = r.json().result;
    assert.equal(result.position, '司机');
    assert.equal(result.scores.attendance.score, 100, '全正常出勤=100');
    assert.equal(result.scores.task.score, 100, '按时完成=100');
    assert.equal(result.scores.quality.score, 90, '质检 90 平均=90');
    assert.equal(result.scores.safety.score, 100, '无奖惩=100');
    // 司机权重:attendance20 quality20 task30 safety25 → 归一化
    assert.equal(result.total_score, 97.9, '(100*20+90*20+100*30+100*25)/95');
    assert.equal(result.grade, 'S');
    // 不落库:无考核记录
    const list = await app.inject({ method: 'GET', url: '/performance/records', headers: { cookie: hq } });
    assert.equal(list.json().total, 0, '计算不应落库');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT4: 纯计算 — 无权限 403 / 员工不存在 404 / 缺参 400', async () => {
  const { app, dbPath, pm, emp } = await buildFixture();
  try {
    // 绩效专员范围 self,计算别人(5003)应 403
    await seedSource(app, emp);
    const r1 = await app.inject({ method: 'POST', url: '/performance/calculate', headers: { cookie: pm },
      payload: { employee_id: emp, period: '2026-10' } });
    assert.equal(r1.statusCode, 403, `self 范围算别人应 403: ${r1.body}`);

    const hq = await (await app.inject({ method: 'POST', url: '/auth/login',
      payload: { account: 'HQ5001', password: 'Pwd5001@x' } })).headers['set-cookie'];
    const hqCookie = `sid=${hq.match(/sid=([^;]+)/)[1]}`;
    const r2 = await app.inject({ method: 'POST', url: '/performance/calculate', headers: { cookie: hqCookie },
      payload: { employee_id: 999999, period: '2026-10' } });
    assert.equal(r2.statusCode, 404, '员工不存在应 404');

    const r3 = await app.inject({ method: 'POST', url: '/performance/calculate', headers: { cookie: hqCookie },
      payload: { employee_id: emp } });
    assert.equal(r3.statusCode, 400, '缺 period 应 400');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT5: 落库 draft → 确认 → 申诉 全状态机', async () => {
  const { app, dbPath, hq, emp } = await buildFixture();
  try {
    await seedSource(app, emp);

    // draft 落库
    const d = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft', comment: '初评', comment_by: '绩效专员' } });
    assert.equal(d.statusCode, 201, `落库应 201: ${d.body}`);
    const rec = d.json().record;
    assert.equal(rec.status, 'draft');
    assert.equal(rec.total_score, 97.9);
    assert.equal(rec.grade, 'S');

    // 重复落库同周期 → 409(不静默覆盖)
    const dup = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    assert.equal(dup.statusCode, 409, '重复落库应 409');
    assert.equal(dup.json().record.id, rec.id, '409 应返回已有记录');

    // 未确认直接申诉 → 409
    const early = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'appealed' } });
    assert.equal(early.statusCode, 409, '草稿直接申诉应 409');

    // 确认
    const c = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed', comment_by: '部门经理' } });
    assert.equal(c.statusCode, 200, `确认应 200: ${c.body}`);
    assert.equal(c.json().record.status, 'confirmed');
    assert.ok(c.json().record.confirmed_at, '确认应写 confirmed_at');

    // 确认后再确认 → 409
    const c2 = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed' } });
    assert.equal(c2.statusCode, 409, '重复确认应 409');

    // 申诉
    const a = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'appealed', comment: '评分异议', comment_by: '张师傅' } });
    assert.equal(a.statusCode, 200, `申诉应 200: ${a.body}`);
    assert.equal(a.json().record.status, 'appealed');
    assert.ok(a.json().record.confirmed_at, '申诉应保留 confirmed_at');

    // 不存在的记录确认 → 404
    const nf = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-11', status: 'confirmed' } });
    assert.equal(nf.statusCode, 404, '无记录确认应 404');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT6: 落库权限 — save/confirm 各自校验', async () => {
  const { app, dbPath, pm, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    // 绩效专员范围 self,save 别人应 403
    const r1 = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: pm },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    assert.equal(r1.statusCode, 403, `self 范围 save 别人应 403: ${r1.body}`);

    // 非法 status → 400
    const hq = await (await app.inject({ method: 'POST', url: '/auth/login',
      payload: { account: 'HQ5001', password: 'Pwd5001@x' } })).headers['set-cookie'];
    const hqCookie = `sid=${hq.match(/sid=([^;]+)/)[1]}`;
    const r2 = await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hqCookie },
      payload: { employee_id: emp, period: '2026-10', status: 'bogus' } });
    assert.equal(r2.statusCode, 400, '非法 status 应 400');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT7: 分页查询 — 筛选 + 分页 + 汇总字段', async () => {
  const { app, dbPath, hq, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'confirmed' } });
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-11', status: 'draft' } });

    const r = await app.inject({ method: 'GET', url: '/performance/records?page=1&limit=1', headers: { cookie: hq } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.total, 2);
    assert.equal(body.pages, 2);
    assert.equal(body.items.length, 1, 'limit=1 返回 1 条');
    assert.ok(body.items[0].emp_name, '应含员工名');

    const f = await app.inject({ method: 'GET', url: '/performance/records?status=confirmed&period=2026-10', headers: { cookie: hq } });
    assert.equal(f.json().total, 1, '按 status+period 筛选应 1 条');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T01-RT8: 单条查询 — 有记录返回 / 无记录 404 / 越权 403', async () => {
  const { app, dbPath, hq, pm, emp } = await buildFixture();
  try {
    await seedSource(app, emp);
    await app.inject({ method: 'POST', url: '/performance/records', headers: { cookie: hq },
      payload: { employee_id: emp, period: '2026-10', status: 'draft' } });

    // 总部查单条
    const r = await app.inject({ method: 'GET', url: `/performance/records/${emp}/2026-10`, headers: { cookie: hq } });
    assert.equal(r.statusCode, 200);
    const rec = r.json().record;
    assert.equal(rec.status, 'draft');
    assert.equal(rec.scores.attendance.score, 100, '应返回解析后的 scores');
    assert.equal(rec.weights.attendance, 20, '应返回权重');

    // 无记录
    const nf = await app.inject({ method: 'GET', url: `/performance/records/${emp}/2026-01`, headers: { cookie: hq } });
    assert.equal(nf.statusCode, 404);

    // 绩效专员范围 self,查别人 403
    const forbid = await app.inject({ method: 'GET', url: `/performance/records/${emp}/2026-10`, headers: { cookie: pm } });
    assert.equal(forbid.statusCode, 403, 'self 范围查别人应 403');
  } finally { await cleanup(app, dbPath); }
});
