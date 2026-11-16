// seed-import.test.js — P0-T07 seed 批量导入(幂等)
// 验收:重复导入不重复;模板下载;逐行结果。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'seed-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 1101, account: 'EMP1101', password: 'Pwd1101@x', name: 'Admin',
    position: '管理员', department: '总部',
    permissions: { mode: 'manual', level: 4, scope: 'group', modules: {}, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 1102, account: 'EMP1102', password: 'Pwd1102@x', name: 'Worker',
    position: '保洁员', department: '一线',
    permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return { app, dbPath, cookies: { admin: await login('EMP1101', 'Pwd1101@x'), worker: await login('EMP1102', 'Pwd1102@x') } };
}

// ---- 模板下载 ----
test('T07-01: GET /seed/template 返回模板', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    for (const type of ['items', 'employees', 'depots']) {
      const r = await app.inject({ method: 'GET', url: `/seed/template?type=${type}`, headers: { cookie: cookies.admin } });
      assert.equal(r.statusCode, 200, `${type} 模板应 200`);
      assert.equal(r.json().type, type);
      assert.ok(r.json().sample, `应含 sample: ${type}`);
      assert.ok(r.json().fields, `应含 fields: ${type}`);
    }
    // 非法 type
    const bad = await app.inject({ method: 'GET', url: '/seed/template?type=nope', headers: { cookie: cookies.admin } });
    assert.equal(bad.statusCode, 400);
    // 非管理员 403
    const deny = await app.inject({ method: 'GET', url: '/seed/template?type=items', headers: { cookie: cookies.worker } });
    assert.equal(deny.statusCode, 403);
  } finally { await cleanup(app, dbPath); }
});

// ---- items 导入 + 幂等 ----
test('T07-02: items 批量导入,重复导入不重复(幂等)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const items = [
      { id: 'INV-Z1', name: '测试物资1', category: 'consumable', unit: '个', stock: 50, min_stock: 5, unit_cost: 100, depot_id: 'DP-001' },
      { id: 'INV-Z2', name: '测试物资2', category: 'tool', unit: '把', stock: 20, min_stock: 2, unit_cost: 300, depot_id: 'DP-001' },
    ];
    const r1 = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'items', data: items }
    });
    assert.equal(r1.statusCode, 200, `首次导入应 200: ${r1.body}`);
    assert.equal(r1.json().success, 2, '2 条应成功');
    assert.equal(r1.json().failed, 0);

    // 验证落库
    const cnt1 = app.db.prepare("SELECT COUNT(*) c FROM inventory_item WHERE id IN ('INV-Z1','INV-Z2')").get().c;
    assert.equal(cnt1, 2, '应新增 2 条物资');

    // 重复导入(相同数据)→ 幂等,不新增
    const r2 = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'items', data: items }
    });
    assert.equal(r2.json().success, 2);
    const cnt2 = app.db.prepare("SELECT COUNT(*) c FROM inventory_item WHERE id IN ('INV-Z1','INV-Z2')").get().c;
    assert.equal(cnt2, 2, '重复导入不应新增');

    // 更新 stock(同 id+depot)→ 更新而非新增
    items[0].stock = 999;
    const r3 = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'items', data: [items[0]] }
    });
    assert.equal(r3.json().success, 1);
    const stock = app.db.prepare("SELECT stock FROM inventory_item WHERE id='INV-Z1' AND depot_id='DP-001'").get().stock;
    assert.equal(stock, 999, 'stock 应更新为 999');
  } finally { await cleanup(app, dbPath); }
});

// ---- employees 导入 ----
test('T07-03: employees 导入,含密码;重复导入不重复', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const emps = [
      { employee_id: 3001, name: '导入员工1', position: '保洁员', department: '一线', account: 'EMP3001', password: 'Pwd3001@x' },
      { employee_id: 3002, name: '导入员工2', position: '司机', department: '运输', account: 'EMP3002' },
    ];
    const r1 = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'employees', data: emps }
    });
    assert.equal(r1.json().success, 2, `应成功 2 条: ${JSON.stringify(r1.json().results)}`);

    // 验证能登录(密码已设)
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { account: 'EMP3001', password: 'Pwd3001@x' } });
    assert.equal(login.statusCode, 200, '导入的员工应能登录');

    // 重复导入 → 不新增
    const cnt1 = app.db.prepare("SELECT COUNT(*) c FROM employees WHERE employee_id IN (3001,3002)").get().c;
    const r2 = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'employees', data: emps }
    });
    const cnt2 = app.db.prepare("SELECT COUNT(*) c FROM employees WHERE employee_id IN (3001,3002)").get().c;
    assert.equal(cnt2, cnt1, '重复导入不应新增员工');
  } finally { await cleanup(app, dbPath); }
});

// ---- depots 导入 ----
test('T07-04: depots 导入 + 幂等', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const r = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'depots', data: [{ id: 'DP-X1', name: '测试仓', is_active: 1 }] }
    });
    assert.equal(r.json().success, 1);
    const d1 = app.db.prepare("SELECT name FROM depot WHERE id='DP-X1'").get();
    assert.ok(d1, '仓库应落库');

    // 重复导入
    const r2 = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'depots', data: [{ id: 'DP-X1', name: '测试仓改名' }] }
    });
    assert.equal(r2.json().success, 1);
    const d2 = app.db.prepare("SELECT name FROM depot WHERE id='DP-X1'").get();
    assert.equal(d2.name, '测试仓改名', '名称应更新');
    const cnt = app.db.prepare("SELECT COUNT(*) c FROM depot WHERE id='DP-X1'").get().c;
    assert.equal(cnt, 1, '不应重复');
  } finally { await cleanup(app, dbPath); }
});

// ---- 逐行失败 + 非管理员 ----
test('T07-05: 部分行失败不影响其他行;非管理员 403', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const data = [
      { id: 'DP-OK1', name: '正常仓' },
      { id: '', name: '缺 id' },                      // 失败
      { id: 'DP-OK2', name: '又一个正常仓' },
    ];
    const r = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.admin },
      payload: { type: 'depots', data }
    });
    assert.equal(r.json().success, 2, '应有 2 条成功');
    assert.equal(r.json().failed, 1, '应有 1 条失败');
    assert.equal(r.json().results[1].success, false, '第 2 行应失败');
    assert.ok(r.json().results[1].reason, '失败行应有 reason');

    // 非管理员 403
    const deny = await app.inject({
      method: 'POST', url: '/seed/import', headers: { cookie: cookies.worker },
      payload: { type: 'depots', data: [{ id: 'DP-X', name: 'x' }] }
    });
    assert.equal(deny.statusCode, 403);
  } finally { await cleanup(app, dbPath); }
});
