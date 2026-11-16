// outbox.test.js — P0-T03 离线 outbox 重放
// 验收:断网写入不丢;联网后重放且不重复(幂等键防重放);串行保序。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

// requisition 相关权限也需 fixture
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'outbox-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 9001, account: 'EMP9001', password: 'Pwd9001@x', name: 'Keeper',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { distribution: ['edit'], requisition: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 9002, account: 'EMP9002', password: 'Pwd9002@x', name: 'Approver',
    position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { distribution: ['edit'], requisition: ['approve'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 9003, account: 'EMP9003', password: 'Pwd9003@x', name: 'Foreman',
    position: '班组长', department: '一线', permissions: null
  });
  await seedAccount(app.db, {
    employee_id: 9004, account: 'EMP9004', password: 'Pwd9004@x', name: 'Requester',
    position: '保洁员', department: '一线作业', permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    cookies: {
      keeper: await login('EMP9001', 'Pwd9001@x'),
      approver: await login('EMP9002', 'Pwd9002@x'),
      foreman: await login('EMP9003', 'Pwd9003@x'),
      requester: await login('EMP9004', 'Pwd9004@x'),
    }
  };
}

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

// ---------- P1-T03 新增场景 ----------
test('T03-05: requisition 全链 outbox(创建→审批→出库→本人签收)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 申请人无创建权,用库管员代建(applicant_id 指向 9004)
    const createOps = [{ idempotency_key: 'req-ob-create', method: 'POST', path: '/requisition/requests',
      body: { applicant_id: 9004, department: '一线作业', urgency: '一般-日常补充', depot_id: 'DP-001',
              items: [{ item_id: 'INV-001', qty: 5 }] } }];
    const r1 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: createOps } });
    assert.equal(r1.statusCode, 200, `创建重放应 200: ${r1.body}`);
    const reqId = r1.json().results[0].body.id;
    assert.ok(reqId && reqId.startsWith('MR-'), `应返回 MR- 单号: ${JSON.stringify(r1.json().results[0].body)}`);

    // 审批(审批人)
    const rApprove = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.approver },
      payload: { operations: [{ idempotency_key: 'req-ob-approve', method: 'POST', path: `/requisition/${reqId}/approve` }] } });
    assert.equal(rApprove.json().results[0].status, 200, `审批: ${JSON.stringify(rApprove.json().results[0].body)}`);

    // 出库(库管员)
    const rIssue = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [{ idempotency_key: 'req-ob-issue', method: 'POST', path: `/requisition/${reqId}/issue` }] } });
    assert.equal(rIssue.json().results[0].status, 200, `出库: ${JSON.stringify(rIssue.json().results[0].body)}`);

    // 本人签收(领取人 9004)
    const rReceive = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.requester },
      payload: { operations: [{ idempotency_key: 'req-ob-receive', method: 'POST', path: `/requisition/${reqId}/receive` }] } });
    assert.equal(rReceive.json().results[0].status, 200, `签收: ${JSON.stringify(rReceive.json().results[0].body)}`);

    const rq = app.db.prepare('SELECT status, current_step FROM requisition WHERE id=?').get(reqId);
    assert.equal(rq.status, '已完成');
    assert.equal(rq.current_step, 2);
  } finally { await cleanup(app, dbPath); }
});

test('T03-06: depot-transfer 两步 outbox(移出+移入),库存守恒', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 种子里 INV-001 仅 DP-001;先通过迁移 007 的 DP-002 + 给 DP-002 备货
    // 简化:直接验证 outbox 能代理 depot-transfers 端点;用 DP-001→DP-002(INV-001 在 DP-001 有货)
    const before = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get()?.stock;
    // 先给 DP-002 建一份库存(模拟此前调拨或 seed)
    app.db.prepare(`INSERT OR IGNORE INTO inventory_item (id, name, category, unit, stock, min_stock, unit_cost, depot_id)
                    VALUES ('INV-001','一次性口罩','consumable','包', 0, 10, 800, 'DP-002')`).run();

    const createOps = [{ idempotency_key: 'dt-ob-create', method: 'POST', path: '/depot-transfers',
      body: { from_depot: 'DP-001', to_depot: 'DP-002',
              items: [{ item_id: 'INV-001', qty: 20 }], remark: 'outbox-dt' } }];
    const r1 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: createOps } });
    assert.equal(r1.statusCode, 200, `移出重放应 200: ${r1.body}`);
    const dtId = r1.json().results[0].body.id;
    assert.ok(dtId && dtId.startsWith('DT-'), `应返回 DT- 单号: ${JSON.stringify(r1.json().results[0].body)}`);

    const afterOut = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    assert.equal(afterOut, before - 20, `源仓应扣 20: ${before}→${afterOut}`);

    // 移入
    const r2 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [{ idempotency_key: 'dt-ob-receive', method: 'POST', path: `/depot-transfers/${dtId}/receive` }] } });
    assert.equal(r2.json().results[0].status, 200, `移入: ${JSON.stringify(r2.json().results[0].body)}`);

    const target = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-002'").get().stock;
    assert.equal(target, 20, `目标仓应增 20: ${target}`);
  } finally { await cleanup(app, dbPath); }
});

test('T03-07: 失败重试 — 库存不足逐条返回 409,不影响其他操作', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 先正常建+批+出一单(扣 100)
    const r1 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [{ idempotency_key: 't7-create', method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 100,
                items: [{ item_id: 'INV-003', per_person_qty: 1 }],  // 扫帚 80 把
                recipients: [{ employee_id: 9003 }] } }] } });
    const distId = r1.json().results[0].body.id;
    await app.inject({ method: 'POST', url: `/distribution/${distId}/approve`, headers: { cookie: cookies.approver } });

    const movBefore = app.db.prepare('SELECT COUNT(*) AS c FROM stock_movement').get().c;

    // outbox 一次送两条:先成功 issue(idem-a),再失败 issue(库存不够,100>80-100 已负,但实际第一单已扣 100)
    // 改为:直接对同一单再 issue(状态不允许),应 400;另一条是合法的 seed 查询
    const ops = [
      { idempotency_key: 't7-bad-issue', method: 'POST', path: `/distribution/${distId}/issue` },  // 已批准但已 issue 过?先没 issue
      { idempotency_key: 't7-good', method: 'GET', path: '/distribution/my/pending' },
    ];
    // 第一单还没 issue,先 issue 会成功 → 改造成:预 issue 一次,再重放同单 issue(应幂等缓存 200,不算失败)
    // 真正测 409:建第二单,审批后直接构造库存不足
    const r2 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [{ idempotency_key: 't7-over', method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 999,
                items: [{ item_id: 'INV-003', per_person_qty: 1 }],  // 需 999,只有 80
                recipients: [{ employee_id: 9003 }] } }] } });
    const overId = r2.json().results[0].body.id;
    await app.inject({ method: 'POST', url: `/distribution/${overId}/approve`, headers: { cookie: cookies.approver } });

    const mixed = [
      { idempotency_key: 't7-issue-over', method: 'POST', path: `/distribution/${overId}/issue` },  // 库存不足 → 409
      { idempotency_key: 't7-pending', method: 'GET', path: '/distribution/my/pending' },             // 200
    ];
    const r = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: mixed } });
    assert.equal(r.statusCode, 200);
    const results = r.json().results;
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 409, `库存不足应 409: ${JSON.stringify(results[0].body)}`);
    assert.equal(results[1].status, 200, `查询应 200: ${JSON.stringify(results[1].body)}`);
  } finally { await cleanup(app, dbPath); }
});

test('T03-08: 同键异 body — 幂等键优先,仍返回首次缓存结果', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const key = 't8-same-key';
    const first = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [{ idempotency_key: key, method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 1,
                items: [{ item_id: 'INV-001', per_person_qty: 1 }], recipients: [{ employee_id: 9003 }] } }] } });
    const firstId = first.json().results[0].body.id;

    // 同键,不同 body(不同数量)→ 服务端按 Idempotency-Key 去重,返回首次结果
    const second = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper },
      payload: { operations: [{ idempotency_key: key, method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 99,
                items: [{ item_id: 'INV-001', per_person_qty: 5 }], recipients: [{ employee_id: 9003 }] } }] } });
    assert.equal(second.json().results[0].status, 201, '应命中幂等缓存返回 201');
    assert.equal(second.json().results[0].body.id, firstId, '应返回首次的 id,而非新建');

    // DB 只有一张单
    const cnt = app.db.prepare('SELECT COUNT(*) AS c FROM distribution').get().c;
    assert.equal(cnt, 1, '不应创建第二张单');
  } finally { await cleanup(app, dbPath); }
});

test('T03-09: seed-import 通过 outbox 重放(批量 UPSERT)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const ops = [{ idempotency_key: 'seed-ob-1', method: 'POST', path: '/seed/import',
      body: { type: 'items', data: [
        { id: 'INV-900', name: '新物资A', category: 'consumable', unit: '个', stock: 50, min_stock: 10, unit_cost: 100, depot_id: 'DP-001' },
        { id: 'INV-901', name: '新物资B', category: 'tool', unit: '把', stock: 20, min_stock: 5, unit_cost: 200, depot_id: 'DP-001' },
      ] } }];

    const r1 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: ops } });
    assert.equal(r1.statusCode, 200, `seed 重放应 200: ${r1.body}`);
    const res = r1.json().results[0];
    assert.equal(res.status, 200, `seed import 应 200: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, 2, '两条应都成功');

    // 重放同键 → 命中缓存,不再执行(仍是 success=2,但 DB 不变)
    const r2 = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: ops } });
    assert.equal(r2.json().results[0].status, 200);

    // DB 仍只有 2 条新物资(UPSERT 幂等)
    const cnt = app.db.prepare("SELECT COUNT(*) AS c FROM inventory_item WHERE id IN ('INV-900','INV-901')").get().c;
    assert.equal(cnt, 2);
  } finally { await cleanup(app, dbPath); }
});

test('T03-10: 混合批(发放+领取)按序执行,依赖保序', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 一批里先创建发放,再创建领取;两个独立链路,验证串行不串味
    const ops = [
      { idempotency_key: 'mix-dist-create', method: 'POST', path: '/distribution/requests',
        body: { applicant_id: 9003, depot_id: 'DP-001', total_people: 1,
                items: [{ item_id: 'INV-001', per_person_qty: 1 }], recipients: [{ employee_id: 9003 }] } },
      { idempotency_key: 'mix-req-create', method: 'POST', path: '/requisition/requests',
        body: { applicant_id: 9004, department: '一线作业', urgency: '紧急-当日需要', depot_id: 'DP-001',
                items: [{ item_id: 'INV-002', qty: 3 }] } },
    ];
    const r = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: ops } });
    assert.equal(r.statusCode, 200);
    const results = r.json().results;
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 201, `发放创建: ${JSON.stringify(results[0].body)}`);
    assert.ok(results[0].body.id.startsWith('MD-'), '应 MD- 单号');
    assert.equal(results[1].status, 201, `领取创建: ${JSON.stringify(results[1].body)}`);
    assert.ok(results[1].body.id.startsWith('MR-'), '应 MR- 单号');

    // 两张单都在 DB
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM distribution').get().c, 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM requisition').get().c, 1);
  } finally { await cleanup(app, dbPath); }
});

test('T03-11: 批量 50 条操作一次重放,全部成功', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 50 条创建领取单(轻量,不触发库存)
    const ops = [];
    for (let i = 0; i < 50; i++) {
      ops.push({ idempotency_key: `bulk-${i}`, method: 'POST', path: '/requisition/requests',
        body: { applicant_id: 9004, department: '一线作业', urgency: '一般-日常补充', depot_id: 'DP-001',
                items: [{ item_id: 'INV-004', qty: 1 }] } });
    }
    const r = await app.inject({ method: 'POST', url: '/sync/outbox', headers: { cookie: cookies.keeper }, payload: { operations: ops } });
    assert.equal(r.statusCode, 200);
    const results = r.json().results;
    assert.equal(results.length, 50);
    const fail = results.filter(x => x.status !== 201);
    assert.equal(fail.length, 0, `应全部 201,失败: ${JSON.stringify(fail.slice(0, 3))}`);

    // 50 个不同 id
    const ids = new Set(results.map(x => x.body.id));
    assert.equal(ids.size, 50, '应有 50 个不同单号');
  } finally { await cleanup(app, dbPath); }
});
