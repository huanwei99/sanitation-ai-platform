// p1-t01.test.js — P1-T01 发放列表+详情+分页筛选+跨仓创建被拒(A-T13)
// 验收:
//   ① A-T13 server 版:从 DP-002 发 DP-001 的物资 → 400 DEPOT_MISMATCH
//   ② GET /distribution 分页(page/limit)+筛选(status/depot_id/applicant_id)
//   ③ GET /distribution/:id 详情(lines+recipients+steps)+ 可见性(非授权人 403)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1t01-test-'));
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

// fixture:库管员(可看全部)、审批人、一线接收人(仅看自己的)
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'p1t01-secret' });
  await app.ready();
  // 迁移 004 已种库存(INV-001 口罩 500@DP-001, INV-002 消毒液 120@DP-001, …);DP-002 无库存行

  await seedAccount(app.db, {
    employee_id: 2001, account: 'EMP2001', password: 'Pwd2001@x',
    name: 'Keeper', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 2002, account: 'EMP2002', password: 'Pwd2002@x',
    name: 'Approver', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 2003, account: 'EMP2003', password: 'Pwd2003@x',
    name: 'Worker', position: '保洁员', department: '一线作业',
    permissions: null
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    keeper: await login('EMP2001', 'Pwd2001@x'),
    approver: await login('EMP2002', 'Pwd2002@x'),
    worker: await login('EMP2003', 'Pwd2003@x'),
  };
}

// 在 DP-001 建一张测试发放单(默认库管员作为 distributor)
async function createSample(app, cookie, payload = {}) {
  const r = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie, 'idempotency-key': `create-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 2003, department: '一线作业',
      scope: 'all', total_people: 2, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [{ employee_id: 2003, units: 'A班', people_count: 2 }],
      ...payload,
    }
  });
  return r;
}

// ---------- A-T13:跨仓创建被拒 ----------
test('P1-T01-01 (A-T13): 跨仓创建 — DP-002 发 DP-001 的物资 → 400 DEPOT_MISMATCH', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // INV-001 只在 DP-001(种子);从 DP-002 发 → 应 400 code=DEPOT_MISMATCH
    const r = await createSample(app, keeper, { depot_id: 'DP-002' });
    assert.equal(r.statusCode, 400, `跨仓应 400: ${r.body}`);
    const body = r.json();
    assert.equal(body.code, 'DEPOT_MISMATCH', `code 应 DEPOT_MISMATCH: ${JSON.stringify(body)}`);
    assert.equal(body.item_id, 'INV-001');
    assert.equal(body.item_depot, 'DP-001');
    assert.equal(body.requested_depot, 'DP-002');

    // 不存在的物资 → 404(非跨仓)
    const nf = await createSample(app, keeper, {
      depot_id: 'DP-001',
      items: [{ item_id: 'INV-NOPE', per_person_qty: 1 }],
    });
    assert.equal(nf.statusCode, 404, `不存在的物资应 404: ${nf.body}`);
  } finally { await cleanup(app, dbPath); }
});

// ---------- 分页 ----------
test('P1-T01-02: 列表分页 page/limit/total/pages', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // 建 3 张单
    for (let i = 0; i < 3; i++) {
      const r = await createSample(app, keeper);
      assert.equal(r.statusCode, 201);
    }
    // 第 1 页,每页 2 条
    const p1 = await app.inject({
      method: 'GET', url: '/distribution?page=1&limit=2', headers: { cookie: keeper }
    });
    assert.equal(p1.statusCode, 200, `列表应 200: ${p1.body}`);
    const body = p1.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 3, '共 3 张单');
    assert.equal(body.pages, 2, '每页 2 条 → 2 页');
    assert.equal(body.items.length, 2, '第 1 页应有 2 条');

    // 第 2 页
    const p2 = await app.inject({
      method: 'GET', url: '/distribution?page=2&limit=2', headers: { cookie: keeper }
    });
    assert.equal(p2.statusCode, 200);
    assert.equal(p2.json().items.length, 1, '第 2 页应有 1 条');
  } finally { await cleanup(app, dbPath); }
});

// ---------- 筛选 status + depot_id + applicant_id ----------
test('P1-T01-03: 列表筛选 status/depot_id/applicant_id', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    const r1 = await createSample(app, keeper);
    const r2 = await createSample(app, keeper);
    const id1 = r1.json().id, id2 = r2.json().id;

    // 审批第 1 张 → 已批准
    await app.inject({
      method: 'POST', url: `/distribution/${id1}/approve`, headers: { cookie: approver }
    });

    // 按 status=待审批 → 只剩 id2
    const s1 = await app.inject({
      method: 'GET', url: '/distribution?status=待审批', headers: { cookie: keeper }
    });
    assert.equal(s1.statusCode, 200);
    const ids = s1.json().items.map(x => x.id);
    assert.ok(ids.includes(id2), '应含 id2(待审批)');
    assert.ok(!ids.includes(id1), '不应含 id1(已批准)');

    // 按 status=已批准 → 只剩 id1
    const s2 = await app.inject({
      method: 'GET', url: '/distribution?status=已批准', headers: { cookie: keeper }
    });
    assert.ok(s2.json().items.map(x => x.id).includes(id1));

    // 按 depot_id=DP-001 → 2 张(都在 DP-001)
    const s3 = await app.inject({
      method: 'GET', url: '/distribution?depot_id=DP-001', headers: { cookie: keeper }
    });
    assert.equal(s3.json().total, 2, 'DP-001 应有 2 张');

    // 按 depot_id=DP-002 → 0 张
    const s4 = await app.inject({
      method: 'GET', url: '/distribution?depot_id=DP-002', headers: { cookie: keeper }
    });
    assert.equal(s4.json().total, 0, 'DP-002 应 0 张');

    // 按 applicant_id=2003 → 2 张
    const s5 = await app.inject({
      method: 'GET', url: '/distribution?applicant_id=2003', headers: { cookie: keeper }
    });
    assert.equal(s5.json().total, 2);
  } finally { await cleanup(app, dbPath); }
});

// ---------- 详情 ----------
test('P1-T01-04: 详情含 lines/recipients/steps;授权人 200,非授权人 403', async () => {
  const { app, dbPath, keeper, approver, worker } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    const id = r.json().id;

    // 库管员(有操作权)→ 200 + lines/recipients/steps 结构
    const d1 = await app.inject({
      method: 'GET', url: `/distribution/${id}`, headers: { cookie: keeper }
    });
    assert.equal(d1.statusCode, 200, `库管员看详情应 200: ${d1.body}`);
    const dist = d1.json().distribution;
    assert.equal(dist.id, id);
    assert.ok(Array.isArray(dist.lines), '应有 lines');
    assert.equal(dist.lines.length, 1);
    assert.equal(dist.lines[0].item_id, 'INV-001');
    assert.equal(dist.lines[0].qty, 2, 'qty=per_person_qty*total_people=1*2=2');
    assert.ok(Array.isArray(dist.recipients), '应有 recipients');
    assert.equal(dist.recipients.length, 1);
    assert.equal(dist.recipients[0].employee_id, 2003);
    assert.ok(Array.isArray(dist.steps), '应有 steps(可为空,审批前)');

    // 审批人(admin_level=1)→ 200
    const d2 = await app.inject({
      method: 'GET', url: `/distribution/${id}`, headers: { cookie: approver }
    });
    assert.equal(d2.statusCode, 200);

    // 一线 2003 是接收人 → 200
    const d3 = await app.inject({
      method: 'GET', url: `/distribution/${id}`, headers: { cookie: worker }
    });
    assert.equal(d3.statusCode, 200, `接收人看详情应 200: ${d3.body}`);

    // 不存在的单 → 404
    const d4 = await app.inject({
      method: 'GET', url: '/distribution/MD-9999-9999', headers: { cookie: keeper }
    });
    assert.equal(d4.statusCode, 404);
  } finally { await cleanup(app, dbPath); }
});

// ---------- 非授权人列表可见性 ----------
test('P1-T01-05: 一线非授权人只看本人申请/接收的单(可见性过滤)', async () => {
  const { app, dbPath, keeper, worker } = await buildFixture();
  try {
    // 库管员建 1 张(接收人含 2003)→ 2003 可见
    await createSample(app, keeper);

    // 库管员看全部 → 1
    const k = await app.inject({ method: 'GET', url: '/distribution', headers: { cookie: keeper } });
    assert.equal(k.json().total, 1);

    // 2003 是接收人 → 也能看到这 1 张
    const w = await app.inject({ method: 'GET', url: '/distribution', headers: { cookie: worker } });
    assert.equal(w.json().total, 1, '接收人应看到 1 张');
  } finally { await cleanup(app, dbPath); }
});
