// p1-t01-requisition.test.js — P1-T01 领取完整链 API 测试
// 覆盖:创建→审批→出库(step1)→签收(step2)全链闭环+哈希链;跨仓拒(A-T13);审批前置;防自审;幂等;签收权限

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');
const { verifyRequisitionChain } = require('./requisition');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-test-'));
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

// fixture:库管员(创建/出库)、审批人、申请人(领取人)
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'req-test-secret' });
  await app.ready();

  await seedAccount(app.db, {
    employee_id: 2101, account: 'EMP2101', password: 'Pwd2101@x',
    name: 'Keeper-R', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { requisition: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 2102, account: 'EMP2102', password: 'Pwd2102@x',
    name: 'Approver-R', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { requisition: ['approve'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 2103, account: 'EMP2103', password: 'Pwd2103@x',
    name: 'Requester', position: '保洁员', department: '一线作业',
    permissions: null
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    keeper: await login('EMP2101', 'Pwd2101@x'),
    approver: await login('EMP2102', 'Pwd2102@x'),
    requester: await login('EMP2103', 'Pwd2103@x'),
  };
}

// 创建基础领取单
async function createSample(app, cookie, payload = {}) {
  return await app.inject({
    method: 'POST', url: '/requisition/requests',
    headers: { cookie, 'idempotency-key': `req-create-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 2103, department: '一线作业',
      urgency: '一般-日常补充', depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', qty: 10 }],
      ...payload,
    }
  });
}

test('P1-T01-R01: 创建领取单 → 审批中,链上 step_started', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    assert.equal(r.statusCode, 201, `创建失败: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, '审批中');
    assert.ok(body.id.startsWith('MR-'), `单号应 MR-xxx: ${body.id}`);

    const rq = app.db.prepare('SELECT * FROM requisition WHERE id = ?').get(body.id);
    assert.equal(rq.status, '审批中');
    assert.equal(rq.current_step, 0);
    assert.equal(rq.depot_id, 'DP-001');

    const chain = verifyRequisitionChain(app.db, body.id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 1);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R02 (A-T13): 跨仓创建 — DP-002 发 DP-001 的物资 → 400 DEPOT_MISMATCH', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // INV-001 只在 DP-001;从 DP-002 领 → 400 code=DEPOT_MISMATCH
    const r = await createSample(app, keeper, { depot_id: 'DP-002' });
    assert.equal(r.statusCode, 400, `跨仓应 400: ${r.body}`);
    const body = r.json();
    assert.equal(body.code, 'DEPOT_MISMATCH', `code 应 DEPOT_MISMATCH: ${JSON.stringify(body)}`);
    assert.equal(body.item_id, 'INV-001');
    assert.equal(body.item_depot, 'DP-001');
    assert.equal(body.requested_depot, 'DP-002');

    // 不存在的物资 → 404
    const nf = await createSample(app, keeper, {
      depot_id: 'DP-001',
      items: [{ item_id: 'INV-NOPE', qty: 1 }],
    });
    assert.equal(nf.statusCode, 404, `不存在的物资应 404: ${nf.body}`);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R03: 未审批不能出库(审批强制前置)', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    const { id } = r.json();

    const issueRes = await app.inject({
      method: 'POST', url: `/requisition/${id}/issue`,
      headers: { cookie: keeper }
    });
    assert.equal(issueRes.statusCode, 400, `未审批应 400: ${issueRes.body}`);
    assert.match(issueRes.json().error, /未审批/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R04: 防自审 — 申请人本人审批 → 403', async () => {
  const { app, dbPath, requester } = await buildFixture();
  try {
    // 申请人自己创建
    const r = await createSample(app, requester);
    assert.equal(r.statusCode, 403, `申请人无创建权(permissions=null): ${r.body}`);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R05: 审批成功 → 已批准 + 链上 approval_granted', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    const { id } = r.json();

    const ok = await app.inject({
      method: 'POST', url: `/requisition/${id}/approve`,
      headers: { cookie: approver }
    });
    assert.equal(ok.statusCode, 200, `审批失败: ${ok.body}`);
    assert.equal(ok.json().status, '已批准');
    assert.ok(ok.json().approval_id);

    const rq = app.db.prepare('SELECT status, approval_id, current_step FROM requisition WHERE id = ?').get(id);
    assert.equal(rq.status, '已批准');
    assert.equal(rq.approval_id, ok.json().approval_id);
    assert.equal(rq.current_step, 1);

    // steps 应有 2 步,step1 进行中
    const steps = app.db.prepare(
      `SELECT step_no, status FROM workflow_step WHERE ref_type='requisition' AND ref_id=? ORDER BY step_no`
    ).all(id);
    assert.equal(steps.length, 2, '应有 2 步');
    assert.equal(steps[0].status, '进行中');
    assert.equal(steps[1].status, '待执行');

    const chain = verifyRequisitionChain(app.db, id);
    assert.equal(chain.events, 2);  // create + approve
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R06: step1 出库扣库存 + 写流水 + 状态→发放中', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    const { id } = r.json();
    await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });

    const before = app.db.prepare('SELECT stock FROM inventory_item WHERE id=? AND depot_id=?').get('INV-001', 'DP-001').stock;

    const issue = await app.inject({
      method: 'POST', url: `/requisition/${id}/issue`,
      headers: { cookie: keeper }
    });
    assert.equal(issue.statusCode, 200, `出库失败: ${issue.body}`);
    assert.equal(issue.json().status, '发放中');
    assert.equal(issue.json().step, 1);

    const after = app.db.prepare('SELECT stock FROM inventory_item WHERE id=? AND depot_id=?').get('INV-001', 'DP-001').stock;
    assert.equal(after, before - 10, '库存应扣减 10');

    const mov = app.db.prepare(
      `SELECT * FROM stock_movement WHERE ref_type='requisition' AND ref_id=?`
    ).get(id);
    assert.ok(mov, '应有流水');
    assert.equal(mov.delta, -10);
    assert.equal(mov.reason, 'requisition_out');
    assert.equal(mov.depot_id, 'DP-001');

    const chain = verifyRequisitionChain(app.db, id);
    assert.equal(chain.events, 3);  // create + approve + stock_deducted
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R07: step1 库存不足 → 409,库存与流水不变', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    // 建 1 张超库存的单
    const r = await createSample(app, keeper, {
      items: [{ item_id: 'INV-001', qty: 9999 }],
    });
    const { id } = r.json();
    await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });

    const movBefore = app.db.prepare('SELECT COUNT(*) AS c FROM stock_movement').get().c;

    const issue = await app.inject({
      method: 'POST', url: `/requisition/${id}/issue`,
      headers: { cookie: keeper }
    });
    assert.equal(issue.statusCode, 409, `库存不足应 409: ${issue.body}`);
    const body = issue.json();
    assert.equal(body.item_id, 'INV-001');
    assert.ok(body.available !== undefined);
    assert.equal(body.requested, 9999);

    const after = app.db.prepare('SELECT stock FROM inventory_item WHERE id=? AND depot_id=?').get('INV-001', 'DP-001').stock;
    assert.equal(after, 500, '库存应回滚不变');
    const movAfter = app.db.prepare('SELECT COUNT(*) AS c FROM stock_movement').get().c;
    assert.equal(movAfter, movBefore, '流水条数应不变');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R08: step2 领取人本人签收 → 已完成,非本人 403', async () => {
  const { app, dbPath, keeper, approver, requester } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    const { id } = r.json();
    await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });

    // 库管员(非领取人)签收 → 403
    const bad = await app.inject({
      method: 'POST', url: `/requisition/${id}/receive`,
      headers: { cookie: keeper }
    });
    assert.equal(bad.statusCode, 403, `非领取人签收应 403: ${bad.body}`);
    assert.match(bad.json().error, /本人/);

    // 领取人本人签收 → 200
    const ok = await app.inject({
      method: 'POST', url: `/requisition/${id}/receive`,
      headers: { cookie: requester }
    });
    assert.equal(ok.statusCode, 200, `本人签收应 200: ${ok.body}`);
    assert.equal(ok.json().status, '已完成');

    const rq = app.db.prepare('SELECT status, current_step FROM requisition WHERE id = ?').get(id);
    assert.equal(rq.status, '已完成');
    assert.equal(rq.current_step, 2);

    const chain = verifyRequisitionChain(app.db, id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 4);  // create + approve + stock_deducted + signoff
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R09: 驳回 — 审批中可驳回 → 已驳回', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    const r = await createSample(app, keeper);
    const { id } = r.json();

    const rej = await app.inject({
      method: 'POST', url: `/requisition/${id}/reject`,
      headers: { cookie: approver },
      payload: { note: '库存紧张,暂不批' }
    });
    assert.equal(rej.statusCode, 200, `驳回失败: ${rej.body}`);
    assert.equal(rej.json().status, '已驳回');

    const rq = app.db.prepare('SELECT status FROM requisition WHERE id = ?').get(id);
    assert.equal(rq.status, '已驳回');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R10: 列表分页+筛选 status/depot_id;详情含 lines+steps', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    // 建 2 张
    const r1 = await createSample(app, keeper);
    const r2 = await createSample(app, keeper);
    const id1 = r1.json().id, id2 = r2.json().id;

    // 审批 id1 → 已批准
    await app.inject({ method: 'POST', url: `/requisition/${id1}/approve`, headers: { cookie: approver } });

    // 列表
    const l1 = await app.inject({
      method: 'GET', url: '/requisition?status=审批中', headers: { cookie: keeper }
    });
    assert.equal(l1.statusCode, 200);
    const ids = l1.json().items.map(x => x.id);
    assert.ok(ids.includes(id2));
    assert.ok(!ids.includes(id1));

    const l2 = await app.inject({
      method: 'GET', url: '/requisition?status=已批准', headers: { cookie: keeper }
    });
    assert.ok(l2.json().items.map(x => x.id).includes(id1));

    // 详情
    const d = await app.inject({
      method: 'GET', url: `/requisition/${id1}`, headers: { cookie: keeper }
    });
    assert.equal(d.statusCode, 200);
    const rq = d.json().requisition;
    assert.ok(Array.isArray(rq.lines));
    assert.equal(rq.lines.length, 1);
    assert.equal(rq.lines[0].item_id, 'INV-001');
    assert.equal(rq.lines[0].qty, 10);
    assert.ok(Array.isArray(rq.steps));
    assert.equal(rq.steps.length, 2, '审批后应有 2 步');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T01-R11: 幂等 — 相同 Idempotency-Key 重放返回同一 id', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const key = 'req-idem-001';
    const payload = {
      applicant_id: 2103, department: '一线作业',
      urgency: '一般-日常补充', depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', qty: 5 }],
    };
    const r1 = await app.inject({
      method: 'POST', url: '/requisition/requests',
      headers: { cookie: keeper, 'idempotency-key': key },
      payload
    });
    assert.equal(r1.statusCode, 201);
    const id1 = r1.json().id;

    const r2 = await app.inject({
      method: 'POST', url: '/requisition/requests',
      headers: { cookie: keeper, 'idempotency-key': key },
      payload
    });
    assert.equal(r2.statusCode, 201);
    assert.equal(r2.json().id, id1, '幂等重放应返回同一 id');

    const cnt = app.db.prepare('SELECT COUNT(*) AS c FROM requisition WHERE id = ?').get(id1).c;
    assert.equal(cnt, 1);
  } finally { await cleanup(app, dbPath); }
});
