// p1-t03.test.js — P1-T03 外租设备台账 测试
// 覆盖:合同创建/归还/取消/分页筛选/哈希链/幂等/A-T13 跨仓/仅 is_rentable 可租

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');
const { verifyChain } = require('./chain');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-test-'));
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
//   keeper(2301):外租操作员(inventory edit)
//   inspector(2302):管理员(admin_level=1)
//   noPerm(2303):无权限员工
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'rental-test-secret' });
  await app.ready();

  await seedAccount(app.db, {
    employee_id: 2301, account: 'EMP2301', password: 'Pwd2301@x',
    name: 'Rental-Keeper', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 2302, account: 'EMP2302', password: 'Pwd2302@x',
    name: 'Admin', position: '管理员', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { inventory: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 2303, account: 'EMP2303', password: 'Pwd2303@x',
    name: 'NoPerm', position: '保洁员', department: '一线',
    permissions: null
  });

  // 外租设备种子(可租物资,与消耗品分离;复用 is_rented 标记)
  const upsert = app.db.prepare(
    `INSERT INTO inventory_item (id, name, spec, category, unit, stock, min_stock,
                                 unit_cost, is_rented, depot_id)
     VALUES (?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT(id, depot_id) DO UPDATE SET is_rented = 1`
  );
  upsert.run('INV-901', '扫地车', '电动', 'tool', '台', 5, 0, 1500000, 'DP-001');
  upsert.run('INV-902', '高压清洗机', '便携', 'tool', '台', 3, 0, 800000, 'DP-001');
  upsert.run('INV-951', '扫地车', '电动', 'tool', '台', 2, 0, 1500000, 'DP-002');

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    keeper: await login('EMP2301', 'Pwd2301@x'),
    admin: await login('EMP2302', 'Pwd2302@x'),
    noPerm: await login('EMP2303', 'Pwd2303@x'),
  };
}

async function createContract(app, cookie, payload = {}) {
  return await app.inject({
    method: 'POST', url: '/rental/contracts',
    headers: { cookie, 'idempotency-key': `rental-${Date.now()}-${Math.random()}` },
    payload: {
      supplier: '测试设备供应商',
      depot_id: 'DP-001',
      start_date: '2026-11-01',
      items: [{ item_id: 'INV-901', serial_no: 'SN001', qty: 2, day_rate: 5000 }],
      ...payload,
    }
  });
}

test('P1-T03-01: 创建外租合同 → active,写链 created', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const r = await createContract(app, keeper);
    assert.equal(r.statusCode, 201, `创建失败: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'active');
    assert.ok(body.id.startsWith('RC-'), `单号应 RC-xxx: ${body.id}`);

    const contract = app.db.prepare('SELECT * FROM rental_contract WHERE id = ?').get(body.id);
    assert.equal(contract.status, 'active');
    assert.equal(contract.supplier, '测试设备供应商');
    assert.equal(contract.created_by, 2301);

    const items = app.db.prepare('SELECT * FROM rental_item WHERE contract_id = ?').all(body.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].item_id, 'INV-901');
    assert.equal(items[0].serial_no, 'SN001');
    assert.equal(items[0].qty, 2);
    assert.equal(items[0].day_rate, 5000);
    assert.equal(items[0].status, 'rented');

    // 链上 created
    const chain = verifyChain(app.db, 'rental', body.id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 1);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-02 (A-T13): 跨仓外租登记 → 400 DEPOT_MISMATCH', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // INV-901 只在 DP-001;从 DP-002 外租 → 400 DEPOT_MISMATCH
    const r = await createContract(app, keeper, {
      depot_id: 'DP-002',
      items: [{ item_id: 'INV-901', serial_no: 'SN001', qty: 1, day_rate: 5000 }],
    });
    assert.equal(r.statusCode, 400, `跨仓应 400: ${r.body}`);
    const body = r.json();
    assert.equal(body.code, 'DEPOT_MISMATCH');
    assert.equal(body.item_id, 'INV-901');
    assert.equal(body.item_depot, 'DP-001');
    assert.equal(body.requested_depot, 'DP-002');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-03: 非 is_rented 物资 → 400 拒绝', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // 先把 INV-901 标记为不可外租
    app.db.prepare("UPDATE inventory_item SET is_rented = 0 WHERE id = 'INV-901'").run();

    const r = await createContract(app, keeper);
    assert.equal(r.statusCode, 400, `非可租应 400: ${r.body}`);
    assert.match(r.json().error, /未标记为可外租/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-04: 归还部分设备 → 结算租金,合同保持 active', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const c = await createContract(app, keeper, {
      items: [
        { item_id: 'INV-901', serial_no: 'SN001', qty: 1, day_rate: 5000 },
        { item_id: 'INV-901', serial_no: 'SN002', qty: 1, day_rate: 5000 },
      ],
    });
    const id = c.json().id;
    const items = app.db.prepare(
      "SELECT id FROM rental_item WHERE contract_id = ? ORDER BY id"
    ).all(id);

    // 归还第一台
    const r = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: keeper, 'idempotency-key': `ret-${Date.now()}` },
      payload: { rental_item_ids: [items[0].id], return_note: '一台先回' },
    });
    assert.equal(r.statusCode, 200, `归还失败: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.contract_status, 'active', '还有一台未还,合同应保持 active');
    assert.equal(body.returned_count, 1);
    assert.ok(body.total_fee >= 5000, `租金应 >= 5000: ${body.total_fee}`);

    const item1 = app.db.prepare('SELECT * FROM rental_item WHERE id = ?').get(items[0].id);
    assert.equal(item1.status, 'returned');
    assert.equal(item1.return_fee, body.total_fee);

    const item2 = app.db.prepare('SELECT * FROM rental_item WHERE id = ?').get(items[1].id);
    assert.equal(item2.status, 'rented');

    // 链上 2 事件(created + rent_returned)
    const chain = verifyChain(app.db, 'rental', id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 2);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-05: 全部归还 → 合同推到 returned', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const c = await createContract(app, keeper);
    const id = c.json().id;

    const r = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: keeper, 'idempotency-key': `ret-all-${Date.now()}` },
      payload: { return_note: '全部归还' },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.contract_status, 'returned', '全部归还后合同应 closed');
    assert.equal(body.returned_count, 1);

    const contract = app.db.prepare('SELECT * FROM rental_contract WHERE id = ?').get(id);
    assert.equal(contract.status, 'returned');
    assert.equal(contract.return_actor, 2301);

    // 链上 2 事件
    const chain = verifyChain(app.db, 'rental', id);
    assert.equal(chain.events, 2);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-06: 已归还合同不可重复归还', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const c = await createContract(app, keeper);
    const id = c.json().id;

    // 第一次归还 → 200
    await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: keeper },
      payload: {},
    });

    // 第二次归还 → 400 状态非 active
    const r = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: keeper },
      payload: {},
    });
    assert.equal(r.statusCode, 400, `重复归还应 400: ${r.body}`);
    assert.match(r.json().error, /仅 active 可归还/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-07: 取消合同(无归还设备)→ cancelled', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const c = await createContract(app, keeper);
    const id = c.json().id;

    const r = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/cancel`,
      headers: { cookie: keeper, 'idempotency-key': `cancel-${Date.now()}` },
      payload: { note: '合同终止' },
    });
    assert.equal(r.statusCode, 200, `取消失败: ${r.body}`);
    assert.equal(r.json().status, 'cancelled');

    const contract = app.db.prepare('SELECT * FROM rental_contract WHERE id = ?').get(id);
    assert.equal(contract.status, 'cancelled');

    // 设备也标记为 returned
    const items = app.db.prepare(
      "SELECT status, return_note FROM rental_item WHERE contract_id = ?"
    ).all(id);
    assert.equal(items[0].status, 'returned');
    assert.equal(items[0].return_note, '合同取消');

    // 链上 2 事件(created + cancel)
    const chain = verifyChain(app.db, 'rental', id);
    assert.equal(chain.events, 2);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-08: 有归还设备不可取消', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const c = await createContract(app, keeper, {
      items: [
        { item_id: 'INV-901', serial_no: 'SN001', qty: 1, day_rate: 5000 },
        { item_id: 'INV-901', serial_no: 'SN002', qty: 1, day_rate: 5000 },
      ],
    });
    const id = c.json().id;
    const items = app.db.prepare(
      "SELECT id FROM rental_item WHERE contract_id = ? ORDER BY id"
    ).all(id);

    // 归还一台
    await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: keeper },
      payload: { rental_item_ids: [items[0].id] },
    });

    // 取消合同 → 400
    const r = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/cancel`,
      headers: { cookie: keeper },
      payload: {},
    });
    assert.equal(r.statusCode, 400, `有归还设备应拒取消: ${r.body}`);
    assert.match(r.json().error, /已归还设备/);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-09: 创建幂等键防重放', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const idemKey = `rental-idem-${Date.now()}`;
    const payload = {
      supplier: '幂等供应商',
      depot_id: 'DP-001',
      start_date: '2026-11-01',
      items: [{ item_id: 'INV-901', qty: 3, day_rate: 10000 }],
    };
    const r1 = await app.inject({
      method: 'POST', url: '/rental/contracts',
      headers: { cookie: keeper, 'idempotency-key': idemKey },
      payload,
    });
    assert.equal(r1.statusCode, 201);
    const id1 = r1.json().id;

    // 同 key 重放
    const r2 = await app.inject({
      method: 'POST', url: '/rental/contracts',
      headers: { cookie: keeper, 'idempotency-key': idemKey },
      payload,
    });
    assert.equal(r2.statusCode, 201);
    assert.equal(r2.json().id, id1, '幂等重放应返回首次 id');

    const cnt = app.db.prepare(
      "SELECT COUNT(*) AS cnt FROM rental_contract WHERE supplier='幂等供应商'"
    ).get().cnt;
    assert.equal(cnt, 1);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-10: 列表分页+筛选+详情+汇总', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    // 创建 2 张合同
    const c1 = await createContract(app, keeper, { supplier: 'S-A' });
    const c2 = await createContract(app, keeper, { supplier: 'S-B' });

    // 列表(总)
    const list = await app.inject({ method: 'GET', url: '/rental/contracts', headers: { cookie: keeper } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 2);

    // 按 supplier 筛选
    const bySupplier = await app.inject({
      method: 'GET', url: '/rental/contracts?supplier=S-A', headers: { cookie: keeper },
    });
    assert.equal(bySupplier.json().total, 1);
    assert.equal(bySupplier.json().items[0].id, c1.json().id);

    // 按 status 筛选
    const byStatus = await app.inject({
      method: 'GET', url: '/rental/contracts?status=active', headers: { cookie: keeper },
    });
    assert.equal(byStatus.json().total, 2);

    // 分页
    const page1 = await app.inject({
      method: 'GET', url: '/rental/contracts?page=1&limit=1', headers: { cookie: keeper },
    });
    assert.equal(page1.json().pages, 2);
    assert.equal(page1.json().items.length, 1);

    // 详情(含 items)
    const detail = await app.inject({
      method: 'GET', url: `/rental/contracts/${c1.json().id}`, headers: { cookie: keeper },
    });
    assert.equal(detail.statusCode, 200);
    const d = detail.json().contract;
    assert.equal(d.status, 'active');
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].item_id, 'INV-901');
    assert.equal(d.items[0].qty, 2);
    assert.equal(d.rented_items, 1);

    // 汇总
    const summary = await app.inject({
      method: 'GET', url: '/rental/summary', headers: { cookie: keeper },
    });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().ok, true);
    assert.ok(summary.json().currently_rented.count >= 2, `外租台数应 >= 2: ${summary.json().currently_rented.count}`);

    // 链
    const chain = await app.inject({
      method: 'GET', url: `/rental/contracts/${c1.json().id}/chain`, headers: { cookie: keeper },
    });
    assert.equal(chain.statusCode, 200);
    assert.equal(chain.json().events, 1);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-11: 无权限用户不能创建/归还/取消', async () => {
  const { app, dbPath, keeper, noPerm } = await buildFixture();
  try {
    const c = await createContract(app, keeper);
    const id = c.json().id;

    const r1 = await app.inject({
      method: 'POST', url: '/rental/contracts',
      headers: { cookie: noPerm },
      payload: { supplier: 'X', start_date: '2026-11-01', items: [{ item_id: 'INV-001' }] },
    });
    assert.equal(r1.statusCode, 403, `无权限创建应 403: ${r1.body}`);

    const r2 = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: noPerm },
      payload: {},
    });
    assert.equal(r2.statusCode, 403, `无权限归还应 403`);

    const r3 = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/cancel`,
      headers: { cookie: noPerm },
      payload: {},
    });
    assert.equal(r3.statusCode, 403, `无权限取消应 403`);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T03-12: 多行归还 — 每行独立结算租金', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const c = await createContract(app, keeper, {
      items: [
        { item_id: 'INV-901', serial_no: 'SN001', qty: 1, day_rate: 3000 },
        { item_id: 'INV-901', serial_no: 'SN002', qty: 2, day_rate: 5000 },
        { item_id: 'INV-901', serial_no: 'SN003', qty: 1, day_rate: 8000 },
      ],
    });
    const id = c.json().id;

    // 全部归还
    const r = await app.inject({
      method: 'POST', url: `/rental/contracts/${id}/return`,
      headers: { cookie: keeper },
      payload: {},
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.returned_count, 3);
    assert.equal(body.contract_status, 'returned');

    // 检查每行 return_fee 独立计算
    const items = app.db.prepare(
      "SELECT id, day_rate, qty, return_fee FROM rental_item WHERE contract_id = ? ORDER BY id"
    ).all(id);
    assert.equal(items.length, 3);
    for (const it of items) {
      assert.ok(it.return_fee >= it.day_rate * it.qty, `行 ${it.id} 租金应 >= 日租金*qty: ${it.return_fee}`);
    }

    // 总租金 = 各行之和
    const sumFees = items.reduce((s, it) => s + it.return_fee, 0);
    assert.equal(body.total_fee, sumFees);
  } finally { await cleanup(app, dbPath); }
});
