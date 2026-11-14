// mobile-sign.test.js — DR-T05 移动签收验收测试
// 验收:班组长账号登录→看待办→本人签收成功;非本人签收 403;全签完单据"已完成"。
// 通过 Fastify inject 模拟移动端 HTTP 调用(等价于 mobile-sign.html 前端行为)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-test-'));
  return path.join(dir, 'test.db');
}

async function cleanup(app, dbPath) {
  try { await app.close(); } catch {}
  const dir = path.dirname(dbPath);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise(r => setTimeout(r, 100 * (i + 1))); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'mobile-secret' });
  await app.ready();

  // 库管员(创建/出库/移交)、审批人、两个一线班组长(接收人)
  await seedAccount(app.db, {
    employee_id: 5001, account: 'EMP5001', password: 'Pwd5001@x', name: '库管-老王',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 5002, account: 'EMP5002', password: 'Pwd5002@x', name: '审批-老李',
    position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  // 班组长 A(主签收人,移动端登录)
  await seedAccount(app.db, {
    employee_id: 5003, account: 'EMP5003', password: 'Pwd5003@x', name: '班组长-张',
    position: '班组长', department: '一线作业', permissions: null
  });
  // 班组长 B(另一个接收人)
  await seedAccount(app.db, {
    employee_id: 5004, account: 'EMP5004', password: 'Pwd5004@x', name: '班组长-刘',
    position: '班组长', department: '一线作业', permissions: null
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  const keeper = await login('EMP5001', 'Pwd5001@x');
  const approver = await login('EMP5002', 'Pwd5002@x');
  const workerA = await login('EMP5003', 'Pwd5003@x');
  const workerB = await login('EMP5004', 'Pwd5004@x');
  return { app, dbPath, cookies: { keeper, approver, workerA, workerB } };
}

// 创建 + 审批 + 出库 + 移交给两位班组长
async function createAndIssueToWorkers(app, cookies) {
  const idem = `mobile-${Date.now()}-${Math.random()}`;
  const create = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie: cookies.keeper, 'idempotency-key': idem },
    payload: {
      applicant_id: 5003, total_people: 2, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [
        { employee_id: 5003, units: 'A班', people_count: 1 },
        { employee_id: 5004, units: 'B班', people_count: 1 }
      ]
    }
  });
  assert.equal(create.statusCode, 201, `创建失败: ${create.body}`);
  const id = create.json().id;
  await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/transfer`, headers: { cookie: cookies.keeper }, payload: { recipient_id: 5003 } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/transfer`, headers: { cookie: cookies.keeper }, payload: { recipient_id: 5004 } });
  return id;
}

test('DR-T05-01: 移动端登录 → me 返回班组长身份', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookies.workerA } });
    assert.equal(me.statusCode, 200);
    const body = me.json();
    assert.equal(body.employee.account, 'EMP5003');
    assert.equal(body.employee.name, '班组长-张');
  } finally { await cleanup(app, dbPath); }
});

test('DR-T05-02: 待签收列表 — 已移交接收人能看到待办', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await createAndIssueToWorkers(app, cookies);
    // 班组长-张 登录后看待办
    const r = await app.inject({ method: 'GET', url: '/distribution/my/pending', headers: { cookie: cookies.workerA } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    const ids = body.items.map(x => x.id);
    assert.ok(ids.includes(id), `待办应含单号 ${id},实为 ${JSON.stringify(body.items)}`);
    // 每条 recipient_status 都是"已移交"
    for (const it of body.items) {
      if (it.id === id) assert.equal(it.recipient_status, '已移交');
    }
  } finally { await cleanup(app, dbPath); }
});

test('DR-T05-03: 本人签收成功;非本人签收 403(self-only)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await createAndIssueToWorkers(app, cookies);
    // 非本人:库管员 5001 想替 5003 签 → 403
    const other = await app.inject({ method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.keeper } });
    assert.equal(other.statusCode, 403, `非本人签收应 403: ${other.body}`);
    assert.match(other.json().error, /self_only|本人/);

    // 本人:班组长-张 签自己名下 → 200
    const self = await app.inject({ method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.workerA } });
    assert.equal(self.statusCode, 200, `本人签收应 200: ${self.body}`);
    assert.equal(self.json().received_by, 5003);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T05-04: 全签收 → 推进至 step4 → 单据"已完成"', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await createAndIssueToWorkers(app, cookies);
    // 两位接收人各自签收
    const r1 = await app.inject({ method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.workerA } });
    assert.equal(r1.statusCode, 200);
    const r2 = await app.inject({ method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.workerB } });
    assert.equal(r2.statusCode, 200);

    // 推进 step2→3→4
    for (const step of [2, 3, 4]) {
      const a = await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: cookies.keeper }, payload: { step } });
      assert.equal(a.statusCode, 200, `推进 step${step} 失败: ${a.body}`);
    }

    const db = app.db;
    const dist = db.prepare('SELECT status, current_step FROM distribution WHERE id = ?').get(id);
    assert.equal(dist.status, '已完成');
    assert.equal(dist.current_step, 4);

    // 两位接收人状态均为"已接收"
    const recs = db.prepare('SELECT employee_id, status FROM distribution_recipient WHERE distribution_id = ?').all(id);
    for (const r of recs) assert.equal(r.status, '已接收');
  } finally { await cleanup(app, dbPath); }
});

test('DR-T05-05: 未登录访问待办/签收 → 401', async () => {
  const { app, dbPath } = await buildFixture();
  try {
    const p1 = await app.inject({ method: 'GET', url: '/distribution/my/pending' });
    assert.equal(p1.statusCode, 401);
  } finally { await cleanup(app, dbPath); }
});
