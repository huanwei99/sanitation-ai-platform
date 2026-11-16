// outbox.test.js — P0-T03 离线 outbox 重放
// 验收:断网写入不丢;联网后重放且不重复(幂等键防重放);串行保序。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'outbox-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 9001, account: 'EMP9001', password: 'Pwd9001@x', name: 'Keeper',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 9002, account: 'EMP9002', password: 'Pwd9002@x', name: 'Approver',
    position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 9003, account: 'EMP9003', password: 'Pwd9003@x', name: 'Foreman',
    position: '班组长', department: '一线',
    permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return { app, dbPath, cookies: { keeper: await login('EMP9001', 'Pwd9001@x'), approver: await login('EMP9002', 'Pwd9002@x'), foreman: await login('EMP9003', 'Pwd9003@x') } };
}

test('T03-01: 批量重放一条完整发放链路', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const ops = [
      // 1. 库管员创建发放单
      { idempotency_key: 'ob-create-1', method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 2,
                items: [{ item_id: 'INV-001', per_person_qty: 1 }],
                recipients: [{ employee_id: 9003 }], remark: 'outbox test' } },
    ];
    const r1 = await app.inject({
      method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: ops }
    });
    assert.equal(r1.statusCode, 200, `重放应 200: ${r1.body}`);
    const res1 = r1.json().results;
    assert.equal(res1.length, 1);
    assert.equal(res1[0].status, 201, `创建应 201: ${JSON.stringify(res1[0].body)}`);
    const distId = res1[0].body.id;
    assert.ok(distId, '应返回发放单 id');

    // 2. 审批 + 出库 + 移交 + 签收(不同角色 cookie 各自重放)
    const batch = [
      { idempotency_key: 'ob-approve-1', method: 'POST', path: `/distribution/${distId}/approve` },
      { idempotency_key: 'ob-issue-1', method: 'POST', path: `/distribution/${distId}/issue` },
      { idempotency_key: 'ob-transfer-1', method: 'POST', path: `/distribution/${distId}/transfer`, body: { recipient_id: 9003 } },
      { idempotency_key: 'ob-receive-1', method: 'POST', path: `/distribution/${distId}/receive`, body: { recipient_id: 9003 } },
    ];

    // 审批人重放 approve
    const rApprove = await app.inject({
      method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.approver },
      payload: { operations: [batch[0]] }
    });
    assert.equal(rApprove.json().results[0].status, 200);

    // 库管员重放 issue + transfer
    const rIssue = await app.inject({
      method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [batch[1], batch[2]] }
    });
    assert.equal(rIssue.json().results[0].status, 200, `issue: ${JSON.stringify(rIssue.json().results[0].body)}`);
    assert.equal(rIssue.json().results[1].status, 200, `transfer: ${JSON.stringify(rIssue.json().results[1].body)}`);

    // 班组长代签(白名单)
    const rReceive = await app.inject({
      method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.foreman },
      payload: { operations: [batch[3]] }
    });
    assert.equal(rReceive.json().results[0].status, 200, `receive: ${JSON.stringify(rReceive.json().results[0].body)}`);
  } finally { await cleanup(app, dbPath); }
});

test('T03-02: 幂等重放不重复(库存不二次扣减)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 先查初始库存
    const stockBefore = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001'").get().stock;

    // 第一次重放:创建+审批+出库
    const ops = [
      { idempotency_key: 'idem-create', method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 1,
                items: [{ item_id: 'INV-001', per_person_qty: 1 }],
                recipients: [{ employee_id: 9003 }] } },
    ];
    const r1 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: ops } });
    const distId = r1.json().results[0].body.id;

    await app.inject({ method: 'POST', url: `/distribution/${distId}/approve`, headers: { cookie: cookies.approver } });

    const issueOps = [{ idempotency_key: 'idem-issue', method: 'POST', path: `/distribution/${distId}/issue` }];
    await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: issueOps } });

    const stockAfter1 = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001'").get().stock;
    assert.equal(stockAfter1, stockBefore - 1, `库存应扣减 1, before=${stockBefore} after=${stockAfter1}`);

    // 第二次重放:相同 idempotency_key → 应返回缓存结果,库存不变
    const r2 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: issueOps } });
    assert.equal(r2.json().results[0].status, 200, '重放应返回 200(缓存)');

    const stockAfter2 = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001'").get().stock;
    assert.equal(stockAfter2, stockAfter1, `幂等重放不应二次扣减, after1=${stockAfter1} after2=${stockAfter2}`);
  } finally { await cleanup(app, dbPath); }
});

test('T03-03: 非法操作逐条返回错误,不影响其他操作', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const ops = [
      { idempotency_key: 'bad-1', method: 'POST', path: '/distribution/no-such-id/issue' },  // 不存在的单
      { idempotency_key: 'bad-2' },  // 缺 path
    ];
    const r = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: ops } });
    assert.equal(r.statusCode, 200);
    const results = r.json().results;
    assert.equal(results.length, 2);
    assert.ok(results[0].status >= 400, `第一个应失败: ${results[0].status}`);
    assert.equal(results[1].status, 400, '缺 path 应 400');
  } finally { await cleanup(app, dbPath); }
});

test('T03-04: 未登录 401;空数组 400', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 未登录 → 401(preValidation 先于 body 校验)
    const noAuth = await app.inject({ method: 'POST', url: '/sync/outbox', payload: { operations: [] } });
    assert.equal(noAuth.statusCode, 401);

    // 已登录但空数组 → 400
    const empty = await app.inject({
      method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: [] }
    });
    assert.equal(empty.statusCode, 400);
  } finally { await cleanup(app, dbPath); }
});
