// p1-t02.test.js — P1-T02 入库+质检门 API 测试
// A-T9 质检门全规则:
//   ① 合格 → 已完成 + 写 stock_movement(reason='inbound') + 库存增
//   ② 不合格 → 状态保持待质检 + 不写 stock_movement + 库存不变
//   ③ 已质检不可重复质检
//   ④ 质检人不能与操作人相同
// 附带:跨仓拒(A-T13);创建幂等;列表分页筛选;详情;哈希链

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');
const { verifyChain } = require('./chain');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-test-'));
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

// fixture:
//   keeper(2101):入库操作员(inventory edit)
//   inspector(2102):质检员(admin_level=1,可质检)
//   operator2(2103):另一位库管员(可创建,但不能质检自己创建的单)
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'inbound-test-secret' });
  await app.ready();

  await seedAccount(app.db, {
    employee_id: 2201, account: 'EMP2201', password: 'Pwd2201@x',
    name: 'Inbound-Keeper', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 2202, account: 'EMP2202', password: 'Pwd2202@x',
    name: 'Inspector', position: '质检员', department: '质检部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { inventory: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 2203, account: 'EMP2203', password: 'Pwd2203@x',
    name: 'Keeper2', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { inventory: ['edit'] }, admin_level: 0 }
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    keeper: await login('EMP2201', 'Pwd2201@x'),
    inspector: await login('EMP2202', 'Pwd2202@x'),
    keeper2: await login('EMP2203', 'Pwd2203@x'),
  };
}

async function createSample(app, cookie, payload = {}) {
  return await app.inject({
    method: 'POST', url: '/inbound/requests',
    headers: { cookie, 'idempotency-key': `inbound-${Date.now()}-${Math.random()}` },
    payload: {
      type: '采购入库', supplier: '测试供应商',
      depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', qty: 100, unit_cost: 800 }],
      ...payload,
    }
  });
}

test('P1-T02-01: 创建入库单 → 待质检,无库存变动', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const before = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;

    const r = await createSample(app, keeper);
    assert.equal(r.statusCode, 201, `创建失败: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, '待质检');
    assert.ok(body.id.startsWith('IN-'), `单号应 IN-xxx: ${body.id}`);

    const rec = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(body.id);
    assert.equal(rec.status, '待质检');
    assert.equal(rec.quality_result, '待检');
    assert.equal(rec.operator_id, 2201);
    assert.equal(rec.depot_id, 'DP-001');

    // 创建不增库存,不写 stock_movement
    const after = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    assert.equal(after, before, '创建阶段库存不应变');
    const mv = app.db.prepare("SELECT COUNT(*) AS c FROM stock_movement WHERE ref_type='inbound' AND ref_id=?").get(body.id).c;
    assert.equal(mv, 0, '创建阶段不应写 stock_movement');

    // 链上 created 事件
    const chain = verifyChain(app.db, 'inbound', body.id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 1);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-02 (A-T9 合格): 质检合格 → 已完成 + 库存增 + stock_movement', async () => {
  const { app, dbPath, keeper, inspector } = await buildFixture();
  try {
    const created = await createSample(app, keeper, {
      items: [{ item_id: 'INV-001', qty: 100, unit_cost: 800 }],
    });
    const id = created.json().id;
    const before = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;

    const r = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector, 'idempotency-key': `qc-${Date.now()}` },
      payload: { result: '合格', note: '数量一致,包装完好' },
    });
    assert.equal(r.statusCode, 200, `质检失败: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, '已完成');
    assert.equal(body.quality_result, '合格');
    assert.equal(body.stock_changed, true);

    const rec = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
    assert.equal(rec.status, '已完成');
    assert.equal(rec.quality_result, '合格');
    assert.equal(rec.quality_inspector_id, 2202);

    // 库存应 +100
    const after = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    assert.equal(after, before + 100, `库存应 +100: before=${before} after=${after}`);

    // stock_movement 写入
    const mv = app.db.prepare(
      "SELECT item_id, delta, reason, ref_type, ref_id, line_no, qty_after, actor_id, depot_id FROM stock_movement WHERE ref_type='inbound' AND ref_id=?"
    ).all(id);
    assert.equal(mv.length, 1);
    assert.equal(mv[0].item_id, 'INV-001');
    assert.equal(mv[0].delta, 100);
    assert.equal(mv[0].reason, 'inbound');
    assert.equal(mv[0].qty_after, after);
    assert.equal(mv[0].actor_id, 2202);
    assert.equal(mv[0].depot_id, 'DP-001');

    // 链上 quality_passed
    const chain = verifyChain(app.db, 'inbound', id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 2);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-03 (A-T9 不合格): 质检不合格 → 保持待质检 + 不写流水 + 库存不变', async () => {
  const { app, dbPath, keeper, inspector } = await buildFixture();
  try {
    const created = await createSample(app, keeper, {
      items: [{ item_id: 'INV-002', qty: 50, unit_cost: 1200 }],
    });
    const id = created.json().id;
    const before = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-002' AND depot_id='DP-001'").get().stock;

    const r = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector, 'idempotency-key': `qc-fail-${Date.now()}` },
      payload: { result: '不合格', note: '外包装破损,退回供应商' },
    });
    assert.equal(r.statusCode, 200, `质检失败: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, '待质检', '不合格应保持待质检');
    assert.equal(body.quality_result, '不合格');
    assert.equal(body.stock_changed, false, '不合格不应增库存');

    // 库存不变
    const after = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-002' AND depot_id='DP-001'").get().stock;
    assert.equal(after, before, '不合格不应增库存');

    // 不写 stock_movement
    const mv = app.db.prepare(
      "SELECT COUNT(*) AS c FROM stock_movement WHERE ref_type='inbound' AND ref_id=?"
    ).get(id).c;
    assert.equal(mv, 0, '不合格不应写 stock_movement');

    // quality_result 已记录
    const rec = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
    assert.equal(rec.quality_result, '不合格');
    assert.equal(rec.quality_inspector_id, 2202);
    assert.equal(rec.quality_note, '外包装破损,退回供应商');

    // 链上 quality_failed
    const chain = verifyChain(app.db, 'inbound', id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 2);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-04: 已质检不可重复质检', async () => {
  const { app, dbPath, keeper, inspector } = await buildFixture();
  try {
    const created = await createSample(app, keeper);
    const id = created.json().id;

    // 第一次:合格
    const r1 = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector },
      payload: { result: '合格' },
    });
    assert.equal(r1.statusCode, 200);

    // 第二次:再质检 → 400
    const r2 = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector },
      payload: { result: '不合格' },
    });
    assert.equal(r2.statusCode, 400, `重复质检应 400: ${r2.body}`);
    const body = r2.json();
    assert.match(body.error, /不允许质检|不可重复质检/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-05: 不合格后同样锁定,不可再质检', async () => {
  const { app, dbPath, keeper, inspector } = await buildFixture();
  try {
    const created = await createSample(app, keeper, {
      items: [{ item_id: 'INV-004', qty: 20, unit_cost: 5000 }],
    });
    const id = created.json().id;
    const before = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-004' AND depot_id='DP-001'").get().stock;

    // 第一次:不合格 → 记录 quality_result
    const r1 = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector },
      payload: { result: '不合格', note: '部分破损' },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().status, '待质检');

    // 再次质检(补检为合格)→ 400 已质检锁
    const r2 = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector },
      payload: { result: '合格', note: '复检合格' },
    });
    assert.equal(r2.statusCode, 400, `已质检应锁: ${r2.body}`);
    assert.match(r2.json().error, /不可重复质检/);

    // 库存不变(从未合格过)
    const after = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-004' AND depot_id='DP-001'").get().stock;
    assert.equal(after, before);

    // 无 stock_movement
    const mv = app.db.prepare(
      "SELECT COUNT(*) AS c FROM stock_movement WHERE ref_type='inbound' AND ref_id=?"
    ).get(id).c;
    assert.equal(mv, 0);

    // quality_result 保持不合格
    const rec = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
    assert.equal(rec.quality_result, '不合格');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-06: 质检人不能与入库操作人相同(防自检)', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const created = await createSample(app, keeper); // operator=2201
    const id = created.json().id;

    // keeper 自己质检 → 403
    const r = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: keeper },
      payload: { result: '合格' },
    });
    assert.equal(r.statusCode, 403, `自检应 403: ${r.body}`);
    assert.match(r.json().error, /质检人不能与入库操作人相同/);

    // 数据库未被改动
    const rec = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
    assert.equal(rec.status, '待质检');
    assert.equal(rec.quality_result, '待检');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-07: 不同库管员可质检他人创建的单', async () => {
  const { app, dbPath, keeper, keeper2 } = await buildFixture();
  try {
    // keeper 创建(operator=2201)
    const created = await createSample(app, keeper);
    const id = created.json().id;

    // keeper2(2203, != operator)质检 → 200
    const r = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: keeper2 },
      payload: { result: '合格' },
    });
    assert.equal(r.statusCode, 200, `keeper2 应可质检: ${r.body}`);
    assert.equal(r.json().status, '已完成');

    const rec = app.db.prepare('SELECT * FROM inbound_record WHERE id = ?').get(id);
    assert.equal(rec.quality_inspector_id, 2203);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-08 (A-T13): 跨仓入库 — DP-002 入 DP-001 物资 → 400 DEPOT_MISMATCH', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // INV-001 只在 DP-001;从 DP-002 入库 → 400 code=DEPOT_MISMATCH
    const r = await createSample(app, keeper, { depot_id: 'DP-002' });
    assert.equal(r.statusCode, 400, `跨仓应 400: ${r.body}`);
    const body = r.json();
    assert.equal(body.code, 'DEPOT_MISMATCH');
    assert.equal(body.item_id, 'INV-001');
    assert.equal(body.item_depot, 'DP-001');
    assert.equal(body.requested_depot, 'DP-002');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-09: 创建幂等键防重放', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const idemKey = `inbound-idem-${Date.now()}`;
    const payload = {
      type: '采购入库', supplier: '幂等供应商',
      depot_id: 'DP-001',
      items: [{ item_id: 'INV-003', qty: 30, unit_cost: 1500 }],
    };
    const r1 = await app.inject({
      method: 'POST', url: '/inbound/requests',
      headers: { cookie: keeper, 'idempotency-key': idemKey },
      payload,
    });
    assert.equal(r1.statusCode, 201);
    const id1 = r1.json().id;

    // 同 key 重放 → 返回首次结果
    const r2 = await app.inject({
      method: 'POST', url: '/inbound/requests',
      headers: { cookie: keeper, 'idempotency-key': idemKey },
      payload,
    });
    assert.equal(r2.statusCode, 201);
    assert.equal(r2.json().id, id1, '幂等重放应返回首次 id');

    // 库里只有一份
    const cnt = app.db.prepare(
      "SELECT COUNT(*) AS c FROM inbound_record WHERE supplier='幂等供应商'"
    ).get().c;
    assert.equal(cnt, 1);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-10: 列表分页+筛选+详情+链', async () => {
  const { app, dbPath, keeper, inspector } = await buildFixture();
  try {
    // 创建 2 张入库单,一张合格一张待检
    const c1 = await createSample(app, keeper, { supplier: 'S-A', items: [{ item_id: 'INV-001', qty: 100, unit_cost: 800 }] });
    const c2 = await createSample(app, keeper, { supplier: 'S-B', items: [{ item_id: 'INV-002', qty: 50, unit_cost: 1200 }] });

    // c1 质检合格
    await app.inject({
      method: 'POST', url: `/inbound/${c1.json().id}/quality`,
      headers: { cookie: inspector },
      payload: { result: '合格' },
    });

    // 列表(总)
    const list = await app.inject({ method: 'GET', url: '/inbound', headers: { cookie: keeper } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 2);

    // 按 supplier 筛选
    const bySupplier = await app.inject({
      method: 'GET', url: '/inbound?supplier=S-A', headers: { cookie: keeper },
    });
    assert.equal(bySupplier.json().total, 1);
    assert.equal(bySupplier.json().items[0].id, c1.json().id);

    // 按 status 筛选
    const byStatus = await app.inject({
      method: 'GET', url: '/inbound?status=待质检', headers: { cookie: keeper },
    });
    assert.equal(byStatus.json().total, 1);
    assert.equal(byStatus.json().items[0].id, c2.json().id);

    // 按 quality_result 筛选
    const byQr = await app.inject({
      method: 'GET', url: '/inbound?quality_result=合格', headers: { cookie: keeper },
    });
    assert.equal(byQr.json().total, 1);
    assert.equal(byQr.json().items[0].id, c1.json().id);

    // 分页
    const page1 = await app.inject({
      method: 'GET', url: '/inbound?page=1&limit=1', headers: { cookie: keeper },
    });
    assert.equal(page1.json().total, 2);
    assert.equal(page1.json().pages, 2);
    assert.equal(page1.json().items.length, 1);

    // 详情(含 lines)
    const detail = await app.inject({
      method: 'GET', url: `/inbound/${c1.json().id}`, headers: { cookie: keeper },
    });
    assert.equal(detail.statusCode, 200);
    const d = detail.json().inbound;
    assert.equal(d.status, '已完成');
    assert.equal(d.lines.length, 1);
    assert.equal(d.lines[0].item_id, 'INV-001');
    assert.equal(d.lines[0].qty, 100);
    assert.equal(d.lines[0].unit_cost, 800);
    assert.equal(d.lines[0].line_cost, 80000);

    // 链
    const chain = await app.inject({
      method: 'GET', url: `/inbound/${c1.json().id}/chain`, headers: { cookie: keeper },
    });
    assert.equal(chain.statusCode, 200);
    assert.equal(chain.json().ok, true);
    assert.equal(chain.json().events, 2); // created + quality_passed
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-11: 多行质检合格 — 每行写一条 stock_movement,qty_after 递增', async () => {
  const { app, dbPath, keeper, inspector } = await buildFixture();
  try {
    const created = await createSample(app, keeper, {
      items: [
        { item_id: 'INV-001', qty: 100, unit_cost: 800 },
        { item_id: 'INV-002', qty: 50,  unit_cost: 1200 },
      ],
    });
    const id = created.json().id;

    const before1 = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    const before2 = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-002' AND depot_id='DP-001'").get().stock;

    const r = await app.inject({
      method: 'POST', url: `/inbound/${id}/quality`,
      headers: { cookie: inspector },
      payload: { result: '合格' },
    });
    assert.equal(r.statusCode, 200);

    const after1 = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    const after2 = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-002' AND depot_id='DP-001'").get().stock;
    assert.equal(after1, before1 + 100);
    assert.equal(after2, before2 + 50);

    const mvs = app.db.prepare(
      "SELECT item_id, delta, line_no, qty_after FROM stock_movement WHERE ref_type='inbound' AND ref_id=? ORDER BY line_no"
    ).all(id);
    assert.equal(mvs.length, 2);
    assert.equal(mvs[0].item_id, 'INV-001');
    assert.equal(mvs[0].delta, 100);
    assert.equal(mvs[0].qty_after, after1);
    assert.equal(mvs[1].item_id, 'INV-002');
    assert.equal(mvs[1].delta, 50);
    assert.equal(mvs[1].qty_after, after2);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T02-12: 无权限用户不能创建入库单', async () => {
  const { app, dbPath } = await buildFixture();
  try {
    await seedAccount(app.db, {
      employee_id: 2299, account: 'EMP2299', password: 'Pwd2299@x',
      name: 'NoPerm', position: '保洁员', department: '一线',
      permissions: null
    });
    const r0 = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { account: 'EMP2299', password: 'Pwd2299@x' } });
    const noPermCookie = `sid=${r0.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;

    const r1 = await app.inject({
      method: 'POST', url: '/inbound/requests',
      headers: { cookie: noPermCookie },
      payload: { items: [{ item_id: 'INV-001', qty: 10 }] },
    });
    assert.equal(r1.statusCode, 403, `无权限创建应 403: ${r1.body}`);
  } finally { await cleanup(app, dbPath); }
});
