// regression-ab.test.js — A/B 级修复的回归覆盖
// A-2:无审批权者审批被拒;A-3:申请人不在接收人池签收被拒(堵假成功);
// B-1:无审计查看权者 verify-all/chain 403、events 仅见本人事件;
// B-2:链查询限"申请人/接收人池/有发放操作权"。
// 这几条分支在原有测试里均无覆盖(原 fixture 的申请人都在接收人池、审批人都有 admin_level)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-ab-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'reg-ab-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 6001, account: 'EMP6001', password: 'Pwd6001@x', name: '库管', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 6002, account: 'EMP6002', password: 'Pwd6002@x', name: '审批', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, { employee_id: 6003, account: 'EMP6003', password: 'Pwd6003@x', name: '一线甲', position: '保洁员', department: '一线作业', permissions: null });
  await seedAccount(app.db, { employee_id: 6004, account: 'EMP6004', password: 'Pwd6004@x', name: '一线乙', position: '保洁员', department: '一线作业', permissions: null });
  await seedAccount(app.db, { employee_id: 6005, account: 'EMP6005', password: 'Pwd6005@x', name: '一线丙', position: '保洁员', department: '一线作业', permissions: null });

  async function login(a, p) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account: a, password: p } });
    assert.equal(r.statusCode, 200, `登录失败 ${a}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    cookies: {
      keeper: await login('EMP6001', 'Pwd6001@x'),
      approver: await login('EMP6002', 'Pwd6002@x'),
      workerA: await login('EMP6003', 'Pwd6003@x'),
      workerB: await login('EMP6004', 'Pwd6004@x'),
      workerC: await login('EMP6005', 'Pwd6005@x')
    }
  };
}

// 建单(不审批/不出库),返回单号
async function createOnly(app, cookies, { applicant, recipients }) {
  const create = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie: cookies.keeper, 'idempotency-key': `reg-ab-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: applicant, total_people: 1, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: recipients.map(e => ({ employee_id: e, people_count: 1 }))
    }
  });
  assert.equal(create.statusCode, 201, `创建失败: ${create.body}`);
  return create.json().id;
}

// 建单 + 审批 + 出库 + 逐个移交;返回单号
async function flowTransferred(app, cookies, opts) {
  const id = await createOnly(app, cookies, opts);
  await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper } });
  for (const r of opts.recipients) {
    await app.inject({ method: 'POST', url: `/distribution/${id}/transfer`, headers: { cookie: cookies.keeper }, payload: { recipient_id: r } });
  }
  return id;
}

test('A-2: 无审批权的一线员工审批 → 403,单据状态不变', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await createOnly(app, cookies, { applicant: 6004, recipients: [6003] });
    // 一线甲(无任何权限记录)试图审批
    const bad = await app.inject({
      method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.workerA }
    });
    assert.equal(bad.statusCode, 403, `无审批权应 403: ${bad.body}`);
    assert.match(bad.json().error, /无审批权限/);
    // 单据仍待审批
    const d = app.db.prepare('SELECT status FROM distribution WHERE id = ?').get(id);
    assert.equal(d.status, '待审批');
    // 有审批权的审批人仍可通过
    const ok = await app.inject({
      method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver }
    });
    assert.equal(ok.statusCode, 200);
  } finally { await cleanup(app, dbPath); }
});

test('A-3: 非池内人签收 403(假成功已堵);非白名单代签也 403;池内接收人可签', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 申请人是 6004(保洁员,非白名单),接收人池只有 6003
    const id = await flowTransferred(app, cookies, { applicant: 6004, recipients: [6003] });
    // 申请人 6004 自己签(目标=自己,不在池) → 403
    const byApplicant = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.workerB }
    });
    assert.equal(byApplicant.statusCode, 403, `非池内人签收应 403: ${byApplicant.body}`);
    assert.match(byApplicant.json().error, /接收人不在该单据接收人池/);
    // 申请人 6004 代签 6003(非白名单岗位) → 403
    const proxyByNonWhitelist = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: cookies.workerB }, payload: { recipient_id: 6003 }
    });
    assert.equal(proxyByNonWhitelist.statusCode, 403, `非白名单代签应 403: ${proxyByNonWhitelist.body}`);
    assert.match(proxyByNonWhitelist.json().error, /白名单/);
    // 任何接收人记录都未被改写
    const recs = app.db.prepare('SELECT status FROM distribution_recipient WHERE distribution_id = ?').all(id);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, '已移交');
    // 池内接收人 6003 正常签 → 200
    const self = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.workerA }
    });
    assert.equal(self.statusCode, 200, `池内接收人签收应 200: ${self.body}`);
  } finally { await cleanup(app, dbPath); }
});

test('B-1: 无审计查看权 — verify-all/chain 403,events 仅见本人事件', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await flowTransferred(app, cookies, { applicant: 6004, recipients: [6003] });
    // 一线乙(申请人,无权限记录)
    const verifyAll = await app.inject({ method: 'GET', url: '/audit/verify-all', headers: { cookie: cookies.workerB } });
    assert.equal(verifyAll.statusCode, 403, `verify-all 无权应 403: ${verifyAll.body}`);
    const one = await app.inject({
      method: 'GET', url: `/audit/chain?ref_type=distribution&ref_id=${id}`, headers: { cookie: cookies.workerB }
    });
    assert.equal(one.statusCode, 403);
    // events 可访问,但只能看到自己作为操作人的事件(6004 未参与任何操作 → 0 条)
    const ev = await app.inject({ method: 'GET', url: '/audit/events', headers: { cookie: cookies.workerB } });
    assert.equal(ev.statusCode, 200);
    assert.equal(ev.json().total, 0, '无权者不应看到他人事件');
    // 一线甲签收后,其 events 恰好 1 条(自己的 signoff)
    await app.inject({ method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.workerA } });
    const evA = await app.inject({ method: 'GET', url: '/audit/events', headers: { cookie: cookies.workerA } });
    assert.equal(evA.statusCode, 200);
    assert.equal(evA.json().total, 1, '应只含本人签收事件');
    assert.equal(evA.json().events[0].event, 'signoff');
    // 有权者(approver,admin_level=1)看全量
    const evAdmin = await app.inject({ method: 'GET', url: '/audit/events', headers: { cookie: cookies.approver } });
    assert.equal(evAdmin.statusCode, 200);
    assert.ok(evAdmin.json().total > 1, '审计权者应见全量事件');
  } finally { await cleanup(app, dbPath); }
});

test('B-2: 链查询限权 — 无关人 403,申请人/接收人/库管 200', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await flowTransferred(app, cookies, { applicant: 6004, recipients: [6003] });
    // 无关一线丙 → 403
    const nope = await app.inject({ method: 'GET', url: `/distribution/${id}/chain`, headers: { cookie: cookies.workerC } });
    assert.equal(nope.statusCode, 403, `无关人查链应 403: ${nope.body}`);
    // 库管 → 200
    const byKeeper = await app.inject({ method: 'GET', url: `/distribution/${id}/chain`, headers: { cookie: cookies.keeper } });
    assert.equal(byKeeper.statusCode, 200);
    assert.equal(byKeeper.json().ok, true);
    // 接收人一线甲 → 200
    const byWorker = await app.inject({ method: 'GET', url: `/distribution/${id}/chain`, headers: { cookie: cookies.workerA } });
    assert.equal(byWorker.statusCode, 200);
    // 申请人一线乙 → 200
    const byApplicant = await app.inject({ method: 'GET', url: `/distribution/${id}/chain`, headers: { cookie: cookies.workerB } });
    assert.equal(byApplicant.statusCode, 200);
  } finally { await cleanup(app, dbPath); }
});
