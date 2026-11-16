// p1-t04-statemachine.test.js — P1-T04 状态机:非法状态转移全拒绝
// 覆盖:
//   发放:待审批→(出库/移交/签收)拒绝;已批准→(重复审批/签收)拒绝;发放中→(审批)拒绝;已完成→(一切写操作)拒绝
//   领取:审批中→(出库/签收)拒绝;已批准→(重复审批/签收)拒绝;发放中→(审批/重复出库)拒绝;已完成→(一切写操作)拒绝

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'sm-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 3101, account: 'EMP3101', password: 'Pwd3101@x',
    name: 'Keeper-SM', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { distribution: ['edit'], requisition: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 3102, account: 'EMP3102', password: 'Pwd3102@x',
    name: 'Approver-SM', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { distribution: ['edit'], requisition: ['approve'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 3103, account: 'EMP3103', password: 'Pwd3103@x',
    name: 'Foreman-SM', position: '班组长', department: '一线',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { distribution: ['view'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 3104, account: 'EMP3104', password: 'Pwd3104@x',
    name: 'Requester-SM', position: '保洁员', department: '一线作业',
    permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    keeper: await login('EMP3101', 'Pwd3101@x'),
    approver: await login('EMP3102', 'Pwd3102@x'),
    foreman: await login('EMP3103', 'Pwd3103@x'),
    requester: await login('EMP3104', 'Pwd3104@x'),
  };
}

async function createDist(app, cookie, opts = {}) {
  const r = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie, 'idempotency-key': `sm-d-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 3104, department: '一线作业',
      scope: 'all', total_people: 1, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [{ employee_id: 3104 }],
      ...opts
    }
  });
  assert.equal(r.statusCode, 201, `建发放单失败: ${r.body}`);
  return r.json().id;
}

async function createReq(app, cookie, opts = {}) {
  const r = await app.inject({
    method: 'POST', url: '/requisition/requests',
    headers: { cookie, 'idempotency-key': `sm-r-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 3104, department: '一线作业',
      urgency: '一般-日常补充', depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', qty: 1 }],
      ...opts
    }
  });
  assert.equal(r.statusCode, 201, `建领取单失败: ${r.body}`);
  return r.json().id;
}

// ---------- 发放状态机 ----------
test('P1-T04-D1: 发放 待审批 — 出库/移交/签收 全部拒绝', async () => {
  const { app, dbPath, keeper, approver, foreman } = await buildFixture();
  try {
    const id = await createDist(app, keeper);
    const st = app.db.prepare('SELECT status FROM distribution WHERE id=?').get(id).status;
    assert.equal(st, '待审批');

    // 出库(未审批) → 400
    const issue = await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: keeper } });
    assert.equal(issue.statusCode, 400, `未审批出库应 400: ${issue.body}`);
    assert.match(issue.json().error, /未审批/);

    // 移交(未审批) → 400
    const transfer = await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie: keeper }, payload: { recipient_id: 3104 }
    });
    assert.equal(transfer.statusCode, 400, `未审批移交应 400: ${transfer.body}`);
    assert.match(transfer.json().error, /不允许移交/);

    // 签收(未审批) → 400
    const receive = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: foreman }, payload: { recipient_id: 3104 }
    });
    assert.equal(receive.statusCode, 400, `未审批签收应 400: ${receive.body}`);
    assert.match(receive.json().error, /不允许签收/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-D2: 发放 已批准 — 重复审批拒绝;未出库直接签收拒绝', async () => {
  const { app, dbPath, keeper, approver, foreman } = await buildFixture();
  try {
    const id = await createDist(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    const st = app.db.prepare('SELECT status FROM distribution WHERE id=?').get(id).status;
    assert.equal(st, '已批准');

    // 重复审批 → 400
    const reApprove = await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    assert.equal(reApprove.statusCode, 400, `重复审批应 400: ${reApprove.body}`);
    assert.match(reApprove.json().error, /状态/);

    // 跳过出库直接签收 → 400
    const receive = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: foreman }, payload: { recipient_id: 3104 }
    });
    assert.equal(receive.statusCode, 400, `未出库签收应 400: ${receive.body}`);
    assert.match(receive.json().error, /发放中/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-D3: 发放 发放中 — 重复审批拒绝;未移交直接签收拒绝', async () => {
  const { app, dbPath, keeper, approver, foreman } = await buildFixture();
  try {
    const id = await createDist(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: keeper } });
    const st = app.db.prepare('SELECT status FROM distribution WHERE id=?').get(id).status;
    assert.equal(st, '发放中');

    // 发放中再审批 → 400
    const reApprove = await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    assert.equal(reApprove.statusCode, 400, `发放中再审批应 400: ${reApprove.body}`);
    assert.match(reApprove.json().error, /状态/);

    // 未移交直接签收 → 400
    const receive = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: foreman }, payload: { recipient_id: 3104 }
    });
    assert.equal(receive.statusCode, 400, `未移交签收应 400: ${receive.body}`);
    assert.match(receive.json().error, /需先完成班组移交/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-D4: 发放 已完成 — 审批/出库/移交/签收 全部拒绝', async () => {
  const { app, dbPath, keeper, approver, foreman } = await buildFixture();
  try {
    const id = await createDist(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: keeper } });
    await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie: keeper }, payload: { recipient_id: 3104 }
    });
    const tr = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: foreman }, payload: { recipient_id: 3104 }
    });
    assert.equal(tr.statusCode, 200, `完成签收应 200: ${tr.body}`);
    // 注:receive 仅标接收人已接收;单据推到「已完成」需 advance step4。
    // 此处单据仍「发放中」,验证已接收后无法再移交给同一接收人。
    const rec = app.db.prepare(
      'SELECT status FROM distribution_recipient WHERE distribution_id=? AND employee_id=?'
    ).get(id, 3104);
    assert.equal(rec.status, '已接收', '接收人应已接收');

    // 已接收:再移交同一接收人 → 400(接收人状态不允许)
    const r3 = await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie: keeper }, payload: { recipient_id: 3104 }
    });
    assert.equal(r3.statusCode, 400, `已接收再移交应 400: ${r3.body}`);
    assert.match(r3.json().error, /不能移交/);

    // 已接收:再签收 → 400(已签收过)
    const r4 = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: foreman }, payload: { recipient_id: 3104 }
    });
    assert.equal(r4.statusCode, 400, `已接收再签收应 400: ${r4.body}`);
    assert.match(r4.json().error, /已签收/);

    // 按 2→3→4 推进单据到已完成,再验证写操作全拒绝
    await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: keeper }, payload: { step: 2 } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: keeper }, payload: { step: 3 } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: keeper }, payload: { step: 4 } });
    const st = app.db.prepare('SELECT status FROM distribution WHERE id=?').get(id).status;
    assert.equal(st, '已完成');

    // 已完成:再审批 → 400
    const r5 = await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    assert.equal(r5.statusCode, 400, `已完成再审批应 400: ${r5.body}`);
    // 已完成:再出库 → 400
    const r6 = await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: keeper } });
    assert.equal(r6.statusCode, 400, `已完成再出库应 400: ${r6.body}`);
    // 已完成:再移交 → 400
    const r7 = await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie: keeper }, payload: { recipient_id: 3104 }
    });
    assert.equal(r7.statusCode, 400, `已完成再移交应 400: ${r7.body}`);
  } finally { await cleanup(app, dbPath); }
});

// ---------- 领取状态机 ----------
test('P1-T04-R1: 领取 审批中 — 出库/签收 全部拒绝', async () => {
  const { app, dbPath, keeper, requester } = await buildFixture();
  try {
    const id = await createReq(app, keeper);
    const st = app.db.prepare('SELECT status FROM requisition WHERE id=?').get(id).status;
    assert.equal(st, '审批中');

    // 未审批出库 → 400
    const issue = await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });
    assert.equal(issue.statusCode, 400, `未审批出库应 400: ${issue.body}`);
    assert.match(issue.json().error, /未审批/);

    // 未审批签收 → 400
    const receive = await app.inject({ method: 'POST', url: `/requisition/${id}/receive`, headers: { cookie: requester } });
    assert.equal(receive.statusCode, 400, `未审批签收应 400: ${receive.body}`);
    assert.match(receive.json().error, /发放中/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-R2: 领取 已批准 — 重复审批拒绝;未出库签收拒绝', async () => {
  const { app, dbPath, keeper, approver, requester } = await buildFixture();
  try {
    const id = await createReq(app, keeper);
    await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    const st = app.db.prepare('SELECT status FROM requisition WHERE id=?').get(id).status;
    assert.equal(st, '已批准');

    // 重复审批 → 400
    const reApprove = await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    assert.equal(reApprove.statusCode, 400, `重复审批应 400: ${reApprove.body}`);
    assert.match(reApprove.json().error, /状态/);

    // 未出库签收 → 400
    const receive = await app.inject({ method: 'POST', url: `/requisition/${id}/receive`, headers: { cookie: requester } });
    assert.equal(receive.statusCode, 400, `未出库签收应 400: ${receive.body}`);
    assert.match(receive.json().error, /发放中/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-R3: 领取 发放中 — 重复审批拒绝;重复出库拒绝(应已发放中→已完成路径)', async () => {
  const { app, dbPath, keeper, approver, requester } = await buildFixture();
  try {
    const id = await createReq(app, keeper);
    await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });
    const st = app.db.prepare('SELECT status FROM requisition WHERE id=?').get(id).status;
    assert.equal(st, '发放中');

    // 发放中再审批 → 400
    const reApprove = await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    assert.equal(reApprove.statusCode, 400, `发放中再审批应 400: ${reApprove.body}`);
    assert.match(reApprove.json().error, /状态/);

    // 重复出库 → 400(应走签收,不能反复 issue)
    const reIssue = await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });
    assert.equal(reIssue.statusCode, 400, `重复出库应 400: ${reIssue.body}`);
    assert.match(reIssue.json().error, /不能出库/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-R4: 领取 已完成 — 审批/出库/签收/驳回 全部拒绝', async () => {
  const { app, dbPath, keeper, approver, requester } = await buildFixture();
  try {
    const id = await createReq(app, keeper);
    await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });
    const tr = await app.inject({ method: 'POST', url: `/requisition/${id}/receive`, headers: { cookie: requester } });
    assert.equal(tr.statusCode, 200, `完成签收应 200: ${tr.body}`);
    const st = app.db.prepare('SELECT status FROM requisition WHERE id=?').get(id).status;
    assert.equal(st, '已完成');

    // 已完成:再审批 → 400
    const r1 = await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    assert.equal(r1.statusCode, 400, `已完成再审批应 400: ${r1.body}`);

    // 已完成:再出库 → 400
    const r2 = await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });
    assert.equal(r2.statusCode, 400, `已完成再出库应 400: ${r2.body}`);

    // 已完成:再签收 → 400
    const r3 = await app.inject({ method: 'POST', url: `/requisition/${id}/receive`, headers: { cookie: requester } });
    assert.equal(r3.statusCode, 400, `已完成再签收应 400: ${r3.body}`);

    // 已完成:驳回 → 400(应审批中才能驳回)
    const r4 = await app.inject({
      method: 'POST', url: `/requisition/${id}/reject`,
      headers: { cookie: approver }, payload: { note: 'late reject' }
    });
    assert.equal(r4.statusCode, 400, `已完成驳回应 400: ${r4.body}`);
    assert.match(r4.json().error, /审批中/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-R5: 领取 已驳回 — 审批/出库/签收 全部拒绝', async () => {
  const { app, dbPath, keeper, approver, requester } = await buildFixture();
  try {
    const id = await createReq(app, keeper);
    const rej = await app.inject({
      method: 'POST', url: `/requisition/${id}/reject`,
      headers: { cookie: approver }, payload: { note: '暂不批' }
    });
    assert.equal(rej.statusCode, 200, `驳回应 200: ${rej.body}`);
    const st = app.db.prepare('SELECT status FROM requisition WHERE id=?').get(id).status;
    assert.equal(st, '已驳回');

    // 已驳回:再审批 → 400
    const r1 = await app.inject({ method: 'POST', url: `/requisition/${id}/approve`, headers: { cookie: approver } });
    assert.equal(r1.statusCode, 400, `已驳回再审批应 400: ${r1.body}`);

    // 已驳回:出库 → 400
    const r2 = await app.inject({ method: 'POST', url: `/requisition/${id}/issue`, headers: { cookie: keeper } });
    assert.equal(r2.statusCode, 400, `已驳回出库应 400: ${r2.body}`);

    // 已驳回:签收 → 400
    const r3 = await app.inject({ method: 'POST', url: `/requisition/${id}/receive`, headers: { cookie: requester } });
    assert.equal(r3.statusCode, 400, `已驳回签收应 400: ${r3.body}`);
  } finally { await cleanup(app, dbPath); }
});
