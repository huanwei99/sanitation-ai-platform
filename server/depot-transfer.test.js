// depot-transfer.test.js — P0-T04 仓间调拨(A-T14)
// 验收:调拨后两仓库存与流水一致;移出+移入各记流水。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-test-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'dt-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 1001, account: 'EMP1001', password: 'Pwd1001@x', name: 'Keeper',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'] }, admin_level: 0 }
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return { app, dbPath, cookie: await login('EMP1001', 'Pwd1001@x') };
}

test('T04-01 (A-T14): 完整调拨 — 移出+移入,两仓库存与流水一致', async () => {
  const { app, dbPath, cookie } = await buildFixture();
  try {
    // 初始:INV-001 在 DP-001 有 500 件(种子数据);DP-002 无此物资
    const srcBefore = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    const tgtBeforeRow = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-002'").get();
    const tgtBefore = tgtBeforeRow ? tgtBeforeRow.stock : 0;

    // 移出 100 件 DP-001 → DP-002
    const ship = await app.inject({
      method: 'POST', url: '/depot-transfers',
      headers: { cookie },
      payload: { from_depot: 'DP-001', to_depot: 'DP-002', items: [{ item_id: 'INV-001', qty: 100 }] }
    });
    assert.equal(ship.statusCode, 201, `移出应 201: ${ship.body}`);
    const transferId = ship.json().id;
    assert.ok(transferId.startsWith('DT-'), `单号格式 ${transferId}`);

    // 移出后:源仓 -100,目标仓仍 0(未移入)
    const srcAfterShip = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    assert.equal(srcAfterShip, srcBefore - 100, '源仓应扣减 100');

    // 移入
    const receive = await app.inject({
      method: 'POST', url: `/depot-transfers/${transferId}/receive`,
      headers: { cookie }
    });
    assert.equal(receive.statusCode, 200, `移入应 200: ${receive.body}`);
    assert.equal(receive.json().status, 'received');

    // 移入后:目标仓 +100
    const tgtAfter = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-002'").get().stock;
    assert.equal(tgtAfter, tgtBefore + 100, '目标仓应增加 100');

    // 流水校验:transfer_out + transfer_in 各一条
    const outFlow = app.db.prepare(
      "SELECT delta, qty_after FROM stock_movement WHERE ref_id=? AND reason='transfer_out'"
    ).get(transferId);
    const inFlow = app.db.prepare(
      "SELECT delta, qty_after FROM stock_movement WHERE ref_id=? AND reason='transfer_in'"
    ).get(transferId);
    assert.ok(outFlow, '应有 transfer_out 流水');
    assert.ok(inFlow, '应有 transfer_in 流水');
    assert.equal(outFlow.delta, -100);
    assert.equal(inFlow.delta, 100);
    assert.equal(outFlow.qty_after, srcBefore - 100, '转出后源仓库存应一致');
    assert.equal(inFlow.qty_after, tgtBefore + 100, '转入后目标仓库存应一致');

    // 总量守恒:源仓+目标仓 不变
    const srcFinal = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    assert.equal(srcFinal + tgtAfter, srcBefore + tgtBefore, '两仓总量守恒');
  } finally { await cleanup(app, dbPath); }
});

test('T04-02: 源仓库存不足 → 409,库存不变', async () => {
  const { app, dbPath, cookie } = await buildFixture();
  try {
    const srcBefore = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    const over = srcBefore + 1;
    const r = await app.inject({
      method: 'POST', url: '/depot-transfers',
      headers: { cookie },
      payload: { from_depot: 'DP-001', to_depot: 'DP-002', items: [{ item_id: 'INV-001', qty: over }] }
    });
    assert.equal(r.statusCode, 409, `库存不足应 409: ${r.body}`);
    const srcAfter = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-001'").get().stock;
    assert.equal(srcAfter, srcBefore, '库存不足不应扣减');
  } finally { await cleanup(app, dbPath); }
});

test('T04-03: 同一调拨单重复移入 → 400', async () => {
  const { app, dbPath, cookie } = await buildFixture();
  try {
    const ship = await app.inject({
      method: 'POST', url: '/depot-transfers',
      headers: { cookie },
      payload: { from_depot: 'DP-001', to_depot: 'DP-002', items: [{ item_id: 'INV-001', qty: 10 }] }
    });
    const transferId = ship.json().id;
    await app.inject({ method: 'POST', url: `/depot-transfers/${transferId}/receive`, headers: { cookie } });

    const dup = await app.inject({ method: 'POST', url: `/depot-transfers/${transferId}/receive`, headers: { cookie } });
    assert.equal(dup.statusCode, 400, '重复移入应 400');

    // 库存只加一次
    const tgt = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-001' AND depot_id='DP-002'").get().stock;
    assert.equal(tgt, 10, '目标仓应只加 10(不重复)');
  } finally { await cleanup(app, dbPath); }
});

test('T04-04: 相同仓调拨 → 400;不存在的仓 → 404', async () => {
  const { app, dbPath, cookie } = await buildFixture();
  try {
    const same = await app.inject({
      method: 'POST', url: '/depot-transfers',
      headers: { cookie },
      payload: { from_depot: 'DP-001', to_depot: 'DP-001', items: [{ item_id: 'INV-001', qty: 1 }] }
    });
    assert.equal(same.statusCode, 400, '相同仓应 400');

    const nf = await app.inject({
      method: 'POST', url: '/depot-transfers',
      headers: { cookie },
      payload: { from_depot: 'DP-NOPE', to_depot: 'DP-002', items: [{ item_id: 'INV-001', qty: 1 }] }
    });
    assert.equal(nf.statusCode, 404, '不存在的仓应 404');
  } finally { await cleanup(app, dbPath); }
});
