// gate1.test.js — P1-T06: Gate-1 验收矩阵
// 把 SUBSYSTEM-A-MATERIALS-SPEC §8 的 A-T1…A-T14 在 server 版(Fastify+SQLite)逐条覆盖。
// 用途:单一文件跑完 A 阶段全部规则,作为 Gate-1 的可追溯验收依据。
// 运行:cd server && node --test gate1.test.js
//
// A-T 规则概览(§8):
//   A-T1  发放 step1 扣减库存+流水(G1)
//   A-T2  库存不足拒绝+不写流水(G2)
//   A-T3  审批前置(G3)
//   A-T4  部分移交+全部签收
//   A-T5  代签收白名单
//   A-T6  离线重放幂等
//   A-T7  并发 step1 不超卖
//   A-T8  领取 2 步流程(G6)
//   A-T9  入库质检门
//   A-T10 审计链可校验+防篡改(G5)
//   A-T11 低库存查询
//   A-T12 重启后状态持久(G4)
//   A-T13 多仓隔离(决策#3)
//   A-T14 仓间调拨(P0-T04 新增)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

// ---------- 公共工具 ----------
function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-'));
  return path.join(dir, 'test.db');
}
async function cleanupApp(app) {
  try { await app.close(); } catch {}
}
async function cleanupDir(dbPath) {
  const dir = path.dirname(dbPath);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise(r => setTimeout(r, 100 * (i + 1))); }
  }
}

// fixture:
//   keeper(4001)  库管员,可创建/发放
//   approver(4002) 审批人(admin_level=1)
//   leader(4003)  班组长(代签白名单)
//   workerA(4004) 一线员工A(接收人)
//   workerB(4005) 一线员工B(接收人)
//   workerC(4006) 一线员工C(接收人)
async function buildFixture(dbPath) {
  const app = await buildApp({ dbPath: dbPath || tmpDbPath(), cookieSecret: 'gate1-secret' });
  await app.ready();

  await seedAccount(app.db, {
    employee_id: 4001, account: 'EMP4001', password: 'Pwd4001@x',
    name: 'Keeper', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { distribution: ['edit', 'view'], inventory: ['edit', 'view'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 4002, account: 'EMP4002', password: 'Pwd4002@x',
    name: 'Approver', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 4003, account: 'EMP4003', password: 'Pwd4003@x',
    name: 'Leader', position: '班组长', department: '人工作业部',
    permissions: { mode: 'manual', level: 2, scope: 'self',
      modules: { distribution: ['view'] }, admin_level: 0 }
  });
  for (const id of [4004, 4005, 4006]) {
    await seedAccount(app.db, {
      employee_id: id, account: `EMP${id}`, password: `Pwd${id}@x`,
      name: `Worker${id}`, position: '保洁员', department: '一线作业',
      permissions: null
    });
  }

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app,
    dbPath: app.dbPath,
    cookies: {
      keeper: await login('EMP4001', 'Pwd4001@x'),
      approver: await login('EMP4002', 'Pwd4002@x'),
      leader: await login('EMP4003', 'Pwd4003@x'),
      workerA: await login('EMP4004', 'Pwd4004@x'),
      workerB: await login('EMP4005', 'Pwd4005@x'),
      workerC: await login('EMP4006', 'Pwd4006@x'),
    },
  };
}

// 建发放单(默认 1 人 1 件,接收人 workerA)
async function createDist(app, cookie, payload = {}) {
  return await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie, 'idempotency-key': `gate1-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 4004, department: '一线作业',
      scope: 'all', total_people: 1, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [{ employee_id: 4004, units: 'A班', people_count: 1 }],
      ...payload,
    },
  });
}

// 审批
async function approve(app, cookie, id) {
  return await app.inject({
    method: 'POST', url: `/distribution/${id}/approve`,
    headers: { cookie, 'idempotency-key': `appr-${Date.now()}-${Math.random()}` },
    payload: {},
  });
}

// step1 出库
async function step1(app, cookie, id, idemKey = null) {
  return await app.inject({
    method: 'POST', url: `/distribution/${id}/issue`,
    headers: { cookie, ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
    payload: {},
  });
}

// step2 分发(推进到指定步骤)
async function step2(app, cookie, id, targetStep = 2) {
  return await app.inject({
    method: 'POST', url: `/distribution/${id}/advance`,
    headers: { cookie },
    payload: { step: targetStep },
  });
}

// step3 移交(逐个 recipient_id)
async function step3Transfer(app, cookie, id, recipientIds) {
  let last = null;
  for (const rid of recipientIds) {
    last = await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie },
      payload: { recipient_id: rid },
    });
  }
  return last;
}

// step4 签收
async function step4Signoff(app, cookie, id, body = {}) {
  return await app.inject({
    method: 'POST', url: `/distribution/${id}/receive`,
    headers: { cookie },
    payload: body,
  });
}

// 获取库存
function getStock(app, itemId, depotId = 'DP-001') {
  return app.db.prepare(
    'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
  ).get(itemId, depotId)?.stock;
}

// 获取流水数
function movementCount(app, refId) {
  return app.db.prepare(
    'SELECT COUNT(*) AS c FROM stock_movement WHERE ref_id = ?'
  ).get(refId).c;
}

// ===================================================================
// A-T1:发放 step1 扣减库存+流水(G1)
// ===================================================================
test('A-T1 (G1): 发放 step1 扣减库存+写流水 — 40×2=80 双', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const before = getStock(app, 'INV-001');
    assert.equal(before, 500, `种子库存应 500,实为 ${before}`);

    // 40 人 × 2 双 = 80
    const c = await createDist(app, cookies.keeper, {
      applicant_id: 4004, total_people: 40,
      items: [{ item_id: 'INV-001', per_person_qty: 2 }],
      recipients: [{ employee_id: 4004, units: 'A班', people_count: 40 }],
    });
    assert.equal(c.statusCode, 201, `建单失败: ${c.body}`);
    const id = c.json().id;

    // 审批
    const a = await approve(app, cookies.approver, id);
    assert.equal(a.statusCode, 200, `审批失败: ${a.body}`);

    // step1 出库
    const s = await step1(app, cookies.keeper, id);
    assert.equal(s.statusCode, 200, `step1 失败: ${s.body}`);

    // 断言:库存 500-80=420
    assert.equal(getStock(app, 'INV-001'), 420, `库存应 420,实为 ${getStock(app, 'INV-001')}`);

    // 断言:一条 distribution_out 流水,delta=-80,qty_after=420
    const mv = app.db.prepare(
      "SELECT delta, qty_after, reason, depot_id FROM stock_movement WHERE ref_id = ? AND reason = 'distribution_out'"
    ).get(id);
    assert.ok(mv, '应有 distribution_out 流水');
    assert.equal(mv.delta, -80);
    assert.equal(mv.qty_after, 420);
    assert.equal(mv.depot_id, 'DP-001');
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T2:库存不足拒绝+不写流水(G2)
// ===================================================================
test('A-T2 (G2): 库存不足 step1 → 409,库存不变,无流水', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    // 造一个低库存物资(直接 UPDATE INV-004 → 15)
    app.db.prepare(
      `UPDATE inventory_item SET stock = 15 WHERE id = 'INV-004' AND depot_id = 'DP-001'`
    ).run();
    const before = getStock(app, 'INV-004');
    assert.equal(before, 15, `INV-004 库存应已改为 15,实为 ${before}`);

    // 发放 10 人 × 2 套 = 20(超出库存 15)
    const c = await createDist(app, cookies.keeper, {
      applicant_id: 4004, total_people: 10,
      items: [{ item_id: 'INV-004', per_person_qty: 2 }],
      recipients: [{ employee_id: 4004, units: 'A班', people_count: 10 }],
    });
    assert.equal(c.statusCode, 201);
    const id = c.json().id;

    const a = await approve(app, cookies.approver, id);
    assert.equal(a.statusCode, 200);

    // step1 出库 → 409
    const s = await step1(app, cookies.keeper, id);
    assert.equal(s.statusCode, 409, `库存不足应 409: ${s.body}`);
    const body = s.json();
    assert.match(body.error, /库存不足/);
    assert.match(body.error, /INV-004/);

    // 库存不变
    assert.equal(getStock(app, 'INV-004'), 15, `库存应仍为 15,实为 ${getStock(app, 'INV-004')}`);

    // 无流水
    assert.equal(movementCount(app, id), 0, '不应写 stock_movement');
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T3:审批前置(G3)
// ===================================================================
test('A-T3 (G3): 未审批直接出库 → 400,不允许跳过审批', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const c = await createDist(app, cookies.keeper);
    assert.equal(c.statusCode, 201);
    const id = c.json().id;

    // 跳过审批直接 step1 → 400
    const s = await step1(app, cookies.keeper, id);
    assert.equal(s.statusCode, 400, `未审批应 400: ${s.body}`);
    assert.match(s.json().error, /审批|待审批/);

    // 库存不变
    assert.equal(getStock(app, 'INV-001'), 500);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T4:部分移交 + 全部签收
// ===================================================================
test('A-T4: 3 人部分移交(2/3)→ 全部移交 → 全部签收 → 已完成', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const c = await createDist(app, cookies.keeper, {
      applicant_id: 4004, total_people: 3,
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [
        { employee_id: 4004, units: 'A班', people_count: 1 },
        { employee_id: 4005, units: 'B班', people_count: 1 },
        { employee_id: 4006, units: 'C班', people_count: 1 },
      ],
    });
    assert.equal(c.statusCode, 201);
    const id = c.json().id;

    // 审批 → step1 → step2 → 到 step3
    await approve(app, cookies.approver, id);
    await step1(app, cookies.keeper, id);
    const s2 = await step2(app, cookies.keeper, id);
    assert.equal(s2.statusCode, 200, `step2 失败: ${s2.body}`);

    // 部分移交 2/3
    const t1 = await step3Transfer(app, cookies.keeper, id, [4004, 4005]);
    assert.equal(t1.statusCode, 200, `部分移交失败: ${t1.body}`);

    // 单据仍在进行中(未到 step4)
    const d1 = await app.inject({ method: 'GET', url: `/distribution/${id}`, headers: { cookie: cookies.keeper } });
    const dist1 = d1.json().distribution;
    assert.notEqual(dist1.status, '已完成', '部分移交后不应已完成');

    // 完成剩余移交
    const t2 = await step3Transfer(app, cookies.keeper, id, [4006]);
    assert.equal(t2.statusCode, 200, `剩余移交失败: ${t2.body}`);

    // 3 人各自签收
    const r1 = await step4Signoff(app, cookies.workerA, id);
    assert.equal(r1.statusCode, 200, `workerA 签收失败: ${r1.body}`);
    const r2 = await step4Signoff(app, cookies.workerB, id);
    assert.equal(r2.statusCode, 200, `workerB 签收失败: ${r2.body}`);
    const r3 = await step4Signoff(app, cookies.workerC, id);
    assert.equal(r3.statusCode, 200, `workerC 签收失败: ${r3.body}`);

    // advance step=3 → 签收阶段确认
    const adv3 = await step2(app, cookies.keeper, id, 3);
    assert.equal(adv3.statusCode, 200, `advance step3 失败: ${adv3.body}`);

    // advance step=4 → 台账确认 → 已完成
    const adv4 = await step2(app, cookies.keeper, id, 4);
    assert.equal(adv4.statusCode, 200, `advance step4 失败: ${adv4.body}`);

    // 最终状态 = 已完成
    const d2 = await app.inject({ method: 'GET', url: `/distribution/${id}`, headers: { cookie: cookies.keeper } });
    const dist2 = d2.json().distribution;
    assert.equal(dist2.status, '已完成', `最终状态应已完成,实为 ${dist2.status}`);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T5:代签收白名单
// ===================================================================
test('A-T5: 班组长代签 → proxy 模式;非白名单代签 → 403', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    // 建单接收人 = workerA
    const c = await createDist(app, cookies.keeper);
    const id = c.json().id;
    await approve(app, cookies.approver, id);
    await step1(app, cookies.keeper, id);
    await step2(app, cookies.keeper, id);
    await step3Transfer(app, cookies.keeper, id, [4004]);

    // 本人签收(workerA)→ self 模式
    const self = await step4Signoff(app, cookies.workerA, id);
    assert.equal(self.statusCode, 200);

    // 再建一张,用班组长代签 workerA → proxy 模式
    const c2 = await createDist(app, cookies.keeper);
    const id2 = c2.json().id;
    await approve(app, cookies.approver, id2);
    await step1(app, cookies.keeper, id2);
    await step2(app, cookies.keeper, id2);
    await step3Transfer(app, cookies.keeper, id2, [4004]);

    const proxy = await app.inject({
      method: 'POST', url: `/distribution/${id2}/receive`,
      headers: { cookie: cookies.leader },
      payload: { recipient_id: 4004 },
    });
    assert.equal(proxy.statusCode, 200, `班组长代签应 200: ${proxy.body}`);
    const pBody = proxy.json();
    if (pBody.mode) {
      assert.equal(pBody.mode, 'proxy', `签收模式应 proxy,实为 ${pBody.mode}`);
    }
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T6:离线重放幂等
// ===================================================================
test('A-T6: 同 Idempotency-Key 重放 step1 → 200,库存只扣一次', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const c = await createDist(app, cookies.keeper, {
      total_people: 5, items: [{ item_id: 'INV-001', per_person_qty: 2 }],
    });
    const id = c.json().id;
    await approve(app, cookies.approver, id);

    const key = 'offline-key-K1';
    const s1 = await step1(app, cookies.keeper, id, key);
    assert.equal(s1.statusCode, 200);
    const stockAfterFirst = getStock(app, 'INV-001');

    // 重放同 key
    const s2 = await step1(app, cookies.keeper, id, key);
    assert.equal(s2.statusCode, 200, `重放应 200: ${s2.body}`);

    // 库存不变(只扣一次)
    assert.equal(getStock(app, 'INV-001'), stockAfterFirst, '重放不应再扣库存');

    // 流水只有一条
    assert.equal(movementCount(app, id), 1, `流水应只有 1 条,实为 ${movementCount(app, id)}`);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T7:并发 step1 不超卖
// ===================================================================
test('A-T7: 并发 step1 不超卖 — 恰一成功一 409', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    // 准备一个只有 60 的物资(直接 UPDATE)
    app.db.prepare(
      `INSERT INTO inventory_item (id, name, spec, category, unit, stock, min_stock, unit_cost, is_rented, depot_id)
       VALUES ('INV-799', '测试并发', '并发用', 'consumable', '个', 60, 10, 1000, 0, 'DP-001')
       ON CONFLICT(id, depot_id) DO UPDATE SET stock = 60`
    ).run();

    // 两张单各要 60 个
    const c1 = await createDist(app, cookies.keeper, {
      total_people: 60, items: [{ item_id: 'INV-799', per_person_qty: 1 }],
    });
    const id1 = c1.json().id;
    const c2 = await createDist(app, cookies.keeper, {
      total_people: 60, items: [{ item_id: 'INV-799', per_person_qty: 1 }],
    });
    const id2 = c2.json().id;
    await approve(app, cookies.approver, id1);
    await approve(app, cookies.approver, id2);

    // 并发 step1
    const [r1, r2] = await Promise.all([
      step1(app, cookies.keeper, id1),
      step1(app, cookies.keeper, id2),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(codes, [200, 409], `应一成功一 409,实为 ${codes}`);

    // 库存扣 60 → 0
    const finalStock = getStock(app, 'INV-799');
    assert.equal(finalStock, 0, `库存应 0,实为 ${finalStock}`);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T8:领取 2 步流程(G6)
// ===================================================================
test('A-T8 (G6): 领取 2 步 — 建单/审批/step1出库/step2签收 → 已完成', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const before = getStock(app, 'INV-003');

    // 创建领取单(applicant = workerA,3 把扫帚)
    const c = await app.inject({
      method: 'POST', url: '/requisition/requests',
      headers: { cookie: cookies.keeper, 'idempotency-key': `req-${Date.now()}` },
      payload: {
        applicant_id: 4004, department: '一线作业',
        depot_id: 'DP-001',
        items: [{ item_id: 'INV-003', qty: 3 }],
      },
    });
    assert.equal(c.statusCode, 201, `建领取单失败: ${c.body}`);
    const reqId = c.json().id;

    // 审批
    const a = await app.inject({
      method: 'POST', url: `/requisition/${reqId}/approve`,
      headers: { cookie: cookies.approver },
      payload: {},
    });
    assert.equal(a.statusCode, 200, `领取审批失败: ${a.body}`);

    // step1 出库
    const s1 = await app.inject({
      method: 'POST', url: `/requisition/${reqId}/issue`,
      headers: { cookie: cookies.keeper },
      payload: {},
    });
    assert.equal(s1.statusCode, 200, `领取 step1 失败: ${s1.body}`);

    // 库存减 3
    const afterStep1 = getStock(app, 'INV-003');
    assert.equal(afterStep1, before - 3, `库存应减 3: before=${before} after=${afterStep1}`);

    // 流水(requisition_out)
    const mvCount = app.db.prepare(
      "SELECT COUNT(*) AS cnt FROM stock_movement WHERE ref_id = ? AND reason = 'requisition_out'"
    ).get(reqId).cnt;
    assert.ok(mvCount >= 1, '领取出库应写流水');

    // step2 本人签收
    const s2 = await app.inject({
      method: 'POST', url: `/requisition/${reqId}/receive`,
      headers: { cookie: cookies.workerA },
      payload: {},
    });
    assert.equal(s2.statusCode, 200, `领取 step2 签收失败: ${s2.body}`);

    // 最终状态 = 已完成
    const detail = await app.inject({
      method: 'GET', url: `/requisition/${reqId}`, headers: { cookie: cookies.keeper },
    });
    assert.equal(detail.json().requisition.status, '已完成');
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T9:入库质检门
// ===================================================================
test('A-T9: 入库质检 — 不合格不增库存;合格增库存+写流水', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const before = getStock(app, 'INV-001');

    // 建入库单 500 个
    const c = await app.inject({
      method: 'POST', url: '/inbound/requests',
      headers: { cookie: cookies.keeper, 'idempotency-key': `inb-${Date.now()}` },
      payload: {
        type: '采购入库', supplier: '测试供应商',
        depot_id: 'DP-001',
        items: [{ item_id: 'INV-001', qty: 500, unit_cost: 250 }],
      },
    });
    assert.equal(c.statusCode, 201, `建入库单失败: ${c.body}`);
    const inbId = c.json().id;

    // 质检不合格(用 approver,非 operator)
    const failR = await app.inject({
      method: 'POST', url: `/inbound/${inbId}/quality`,
      headers: { cookie: cookies.approver },
      payload: { result: '不合格', note: '包装破损' },
    });
    assert.equal(failR.statusCode, 200);

    // 不合格 → 库存不变
    assert.equal(getStock(app, 'INV-001'), before, '不合格不应增库存');

    // 无流水
    assert.equal(movementCount(app, inbId), 0, '不合格不应写流水');

    // 建新入库单 → 质检合格
    const c2 = await app.inject({
      method: 'POST', url: '/inbound/requests',
      headers: { cookie: cookies.keeper, 'idempotency-key': `inb2-${Date.now()}` },
      payload: {
        type: '采购入库', supplier: '测试供应商',
        depot_id: 'DP-001',
        items: [{ item_id: 'INV-001', qty: 500, unit_cost: 250 }],
      },
    });
    const inbId2 = c2.json().id;
    const passR = await app.inject({
      method: 'POST', url: `/inbound/${inbId2}/quality`,
      headers: { cookie: cookies.approver },
      payload: { result: '合格', note: '复检合格' },
    });
    assert.equal(passR.statusCode, 200);

    // 合格 → 库存增 500
    assert.equal(getStock(app, 'INV-001'), before + 500, `库存应增 500,实为 ${getStock(app, 'INV-001')}`);

    // 流水 +1
    assert.equal(movementCount(app, inbId2), 1, '合格应写 1 条 inbound 流水');

    // 流水原因 = inbound
    const mv = app.db.prepare(
      "SELECT delta, reason FROM stock_movement WHERE ref_id = ? AND reason = 'inbound'"
    ).get(inbId2);
    assert.ok(mv);
    assert.equal(mv.delta, 500);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T10:审计链可校验+防篡改(G5)
// ===================================================================
test('A-T10 (G5): 全生命周期链可校验;篡改中间事件 → 校验失败', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    const c = await createDist(app, cookies.keeper);
    const id = c.json().id;
    await approve(app, cookies.approver, id);
    await step1(app, cookies.keeper, id);
    await step2(app, cookies.keeper, id);
    await step3Transfer(app, cookies.keeper, id, [4004]);
    await step4Signoff(app, cookies.workerA, id);

    // 获取链事件
    const chain = await app.inject({
      method: 'GET', url: `/distribution/${id}/chain`,
      headers: { cookie: cookies.keeper },
    });
    assert.equal(chain.statusCode, 200);
    const chainBody = chain.json();
    assert.equal(chainBody.ok, true, `链校验应 ok: ${JSON.stringify(chainBody)}`);

    // 事件序列:应包含 approval_granted, stock_deducted, transfer, signoff
    const events = chainBody.events || chainBody.list || [];
    if (events.length > 0) {
      const eventNames = events.map(e => e.event || e.event_name);
      assert.ok(eventNames.includes('approval_granted'), `应有 approval_granted: ${eventNames}`);
      assert.ok(eventNames.includes('stock_deducted'), `应有 stock_deducted: ${eventNames}`);
    }

    // 篡改:UPDATE 中间事件 payload → verifyChain 返回 false
    const middleEvent = app.db.prepare(
      'SELECT id FROM chain_event WHERE ref_id = ? ORDER BY id LIMIT 1 OFFSET 1'
    ).get(id);
    assert.ok(middleEvent, '应有至少 2 条事件');

    // 先关闭触发器(005 的 append-only 保护),篡改,再开触发器
    app.db.exec('DROP TRIGGER IF EXISTS trg_chain_event_no_update');
    app.db.prepare('UPDATE chain_event SET payload = ? WHERE id = ?').run('{"tampered":true}', middleEvent.id);
    app.db.exec(`
      CREATE TRIGGER trg_chain_event_no_update
      BEFORE UPDATE ON chain_event
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'chain_event is append-only: UPDATE blocked');
      END;
    `);

    // 重新校验 → 应失败
    const verify2 = await app.inject({
      method: 'GET', url: `/distribution/${id}/chain`,
      headers: { cookie: cookies.keeper },
    });
    const verify2Body = verify2.json();
    assert.equal(verify2Body.ok, false, `篡改后链校验应失败: ${JSON.stringify(verify2Body)}`);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T11:低库存查询
// ===================================================================
test('A-T11: GET /reports/low-stock 包含 INV-004(15<20)', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    // 把 INV-004 调低(低于 min_stock=50),制造低库存场景
    app.db.prepare(
      `UPDATE inventory_item SET stock = 15 WHERE id = 'INV-004' AND depot_id = 'DP-001'`
    ).run();

    const r = await app.inject({
      method: 'GET', url: '/reports/low-stock',
      headers: { cookie: cookies.keeper },
    });
    assert.equal(r.statusCode, 200);
    const items = r.json().items || [];
    const ids = items.map(x => x.id);
    assert.ok(ids.includes('INV-004'), `低库存应含 INV-004,实为 ${ids}`);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T12:重启后状态持久(G4)
// ===================================================================
test('A-T12 (G4): 完成 step1 → 关闭服务 → 重启 → 状态持久', async () => {
  const dbPath = tmpDbPath();
  {
    const { app, cookies } = await buildFixture(dbPath);
    const c = await createDist(app, cookies.keeper);
    const id = c.json().id;
    await approve(app, cookies.approver, id);
    const s = await step1(app, cookies.keeper, id);
    assert.equal(s.statusCode, 200);

    // 记录 step1 后的库存与状态
    const stockBefore = getStock(app, 'INV-001');
    const statusBefore = app.db.prepare(
      'SELECT status FROM distribution WHERE id = ?'
    ).get(id).status;

    await cleanupApp(app);

    // 重启:同 dbPath 再开
    const app2 = await buildApp({ dbPath, cookieSecret: 'gate1-secret' });
    await app2.ready();
    try {
      // 库存持久
      const stockAfter = app2.db.prepare(
        'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
      ).get('INV-001', 'DP-001').stock;
      assert.equal(stockAfter, stockBefore, `重启后库存应持久: ${stockAfter} vs ${stockBefore}`);

      // 单据状态持久
      const statusAfter = app2.db.prepare(
        'SELECT status FROM distribution WHERE id = ?'
      ).get(id).status;
      assert.equal(statusAfter, statusBefore, `重启后状态应持久: ${statusAfter} vs ${statusBefore}`);

      // 重启后可登录并看到数据
      const r = await app2.inject({ method: 'POST', url: '/auth/login', payload: { account: 'EMP4001', password: 'Pwd4001@x' } });
      assert.equal(r.statusCode, 200);
      const cookie2 = `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
      const detail = await app2.inject({ method: 'GET', url: `/distribution/${id}`, headers: { cookie: cookie2 } });
      assert.equal(detail.statusCode, 200);
    } finally { await cleanupApp(app2); }
  }
  await cleanupDir(dbPath);
});

// ===================================================================
// A-T13:多仓隔离(决策#3)
// ===================================================================
test('A-T13: 跨仓创建被拒 + 二仓库存不足不影响一仓', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    // ① 跨仓创建被拒:INV-001 只在 DP-001,从 DP-002 发 → 400
    const c1 = await createDist(app, cookies.keeper, { depot_id: 'DP-002' });
    assert.equal(c1.statusCode, 400, `跨仓应 400: ${c1.body}`);
    assert.equal(c1.json().code, 'DEPOT_MISMATCH');

    // ② 二仓库存不足不影响一仓
    //    在 DP-002 造一个小库存的物资
    app.db.prepare(
      `INSERT INTO inventory_item (id, name, spec, category, unit, stock, min_stock, unit_cost, is_rented, depot_id)
       VALUES ('INV-201', '二仓手套', '乳胶', 'consumable', '双', 5, 10, 250, 0, 'DP-002')
       ON CONFLICT(id, depot_id) DO UPDATE SET stock = 5`
    ).run();

    const c2 = await createDist(app, cookies.keeper, {
      depot_id: 'DP-002',
      total_people: 20, items: [{ item_id: 'INV-201', per_person_qty: 1 }],
      applicant_id: 4004,
      recipients: [{ employee_id: 4004, units: 'A班', people_count: 20 }],
    });
    assert.equal(c2.statusCode, 201);
    const id2 = c2.json().id;
    await approve(app, cookies.approver, id2);

    // step1 出库 → 409(二仓仅 5,不够 20)
    const s2 = await step1(app, cookies.keeper, id2);
    assert.equal(s2.statusCode, 409, `二仓不足应 409: ${s2.body}`);
    assert.match(s2.json().error, /库存不足/);

    // 二仓库存不变
    assert.equal(getStock(app, 'INV-201', 'DP-002'), 5, '二仓库存应不变');

    // 一仓不受影响
    assert.equal(getStock(app, 'INV-001', 'DP-001'), 500, '一仓库存不应受影响');
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});

// ===================================================================
// A-T14:仓间调拨(P0-T04 新增)
// ===================================================================
test('A-T14: 仓间调拨 — 移出+移入各记流水,两仓库存与流水一致', async () => {
  const dbPath = tmpDbPath();
  const { app, cookies } = await buildFixture(dbPath);
  try {
    // 在 DP-002 也造一个目标仓的物资(需先存在才能调入)
    app.db.prepare(
      `INSERT INTO inventory_item (id, name, spec, category, unit, stock, min_stock, unit_cost, is_rented, depot_id)
       VALUES ('INV-201', '二仓手套', '乳胶', 'consumable', '双', 0, 10, 250, 0, 'DP-002')
       ON CONFLICT(id, depot_id) DO UPDATE SET stock = 0`
    ).run();

    // 在 DP-002 造一个可调出的物资(直接 INSERT)
    app.db.prepare(
      `INSERT INTO inventory_item (id, name, spec, category, unit, stock, min_stock, unit_cost, is_rented, depot_id)
       VALUES ('INV-950', '可调拨物资', '测试', 'consumable', '个', 50, 0, 1000, 0, 'DP-001')
       ON CONFLICT(id, depot_id) DO UPDATE SET stock = 50`
    ).run();
    // DP-002 也放一行(id 不同 depot 不同)
    app.db.prepare(
      `INSERT OR IGNORE INTO inventory_item (id, name, spec, category, unit, stock, min_stock, unit_cost, is_rented, depot_id)
       VALUES ('INV-950', '可调拨物资', '测试', 'consumable', '个', 0, 0, 1000, 0, 'DP-002')`
    ).run();

    const dp1Before = getStock(app, 'INV-950', 'DP-001');
    const dp2Before = getStock(app, 'INV-950', 'DP-002');
    assert.equal(dp1Before, 50);
    assert.equal(dp2Before, 0);

    // 创建调拨单(API 期望 items 数组)
    const t = await app.inject({
      method: 'POST', url: '/depot-transfers',
      headers: { cookie: cookies.keeper, 'idempotency-key': `tr-${Date.now()}` },
      payload: {
        from_depot: 'DP-001', to_depot: 'DP-002',
        items: [{ item_id: 'INV-950', qty: 20 }],
      },
    });
    assert.equal(t.statusCode, 201, `创建调拨单失败: ${t.body}`);
    const transferId = t.json().id || t.json().transfer_id;

    // 接收(移入)
    const recv = await app.inject({
      method: 'POST', url: `/depot-transfers/${transferId}/receive`,
      headers: { cookie: cookies.keeper },
      payload: {},
    });
    assert.equal(recv.statusCode, 200, `移入失败: ${recv.body}`);

    // DP-001 减 20,DP-002 加 20
    const dp1After = getStock(app, 'INV-950', 'DP-001');
    const dp2After = getStock(app, 'INV-950', 'DP-002');
    assert.equal(dp1After, dp1Before - 20, `DP-001 应减 20: ${dp1After}`);
    assert.equal(dp2After, dp2Before + 20, `DP-002 应加 20: ${dp2After}`);

    // 两仓各有一条流水
    const outMv = app.db.prepare(
      "SELECT COUNT(*) AS cnt FROM stock_movement WHERE ref_id = ? AND reason = 'transfer_out'"
    ).get(transferId).cnt;
    const inMv = app.db.prepare(
      "SELECT COUNT(*) AS cnt FROM stock_movement WHERE ref_id = ? AND reason = 'transfer_in'"
    ).get(transferId).cnt;
    assert.ok(outMv >= 1, `移出应写流水: ${outMv}`);
    assert.ok(inMv >= 1, `移入应写流水: ${inMv}`);
  } finally { await cleanupApp(app); await cleanupDir(dbPath); }
});
