// db.test.js — DR-T02 验收测试
// 1. 空库跑 001+002 无错,关键表存在
// 2. 写入数据 → 关闭 → 重新打开 → 数据仍在(A-T12 SQL 版:重启不丢)
// 3. user_version 幂等:重复 runMigrations 不报错、不重复执行

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initDb, runMigrations, getPragmaNumber, sqliteBackend } = require('./db');

// 临时文件库(每次测试独立,测完删除)
function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-test-'));
  return path.join(dir, 'test.db');
}

test('DR-T02-01: 空库执行 001+002 迁移无错', () => {
  const p = tmpDbPath();
  const { db, migrations } = initDb(p);

  assert.equal(migrations.length, 4, '应执行四份迁移(001+002+003+004)');
  assert.equal(migrations[0].skipped, false, '001 首次应执行');
  assert.equal(migrations[1].skipped, false, '002 首次应执行');

  // 验证关键表存在
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);

  for (const t of [
    'employees', 'permissions', 'sessions', 'idempotency_keys',
    'inventory_item', 'stock_movement', 'inbound_record', 'inbound_line',
    'distribution', 'distribution_line', 'distribution_recipient',
    'requisition', 'requisition_line', 'workflow_step', 'chain_event',
    'org_policy', 'depot'
  ]) {
    assert.ok(tables.includes(t), `表 ${t} 应存在`);
  }

  // 默认仓库已插入
  const depots = db.prepare('SELECT id FROM depot ORDER BY id').all();
  assert.deepEqual(depots.map(d => d.id), ['DP-001', 'DP-002']);

  // org_policy 已有默认值
  const policy = db.prepare(
    "SELECT value FROM org_policy WHERE key='distribution.require_approval'"
  ).get();
  assert.equal(policy.value, 'true', '审批强制前置默认为 true');

  db.close();
  fs.rmSync(path.dirname(p), { recursive: true });
});

test('DR-T02-02: 重启后数据保留(A-T12 SQL 版)', () => {
  const p = tmpDbPath();

  // 第一次打开:插入数据
  {
    const { db } = initDb(p);
    db.prepare(
      `INSERT INTO employees (employee_id, name, position, department)
       VALUES (999, '测试员工', '仓库管理员', '仓储部')`
    ).run();
    db.prepare(
      `INSERT INTO inventory_item
       (id, name, category, unit, stock, min_stock, unit_cost)
       VALUES ('INV-T01', '测试物资', 'consumable', '个', 100, 20, 500)`
    ).run();
    db.close();  // 模拟服务停止
  }

  // 第二次打开:验证数据仍在
  {
    const { db } = initDb(p);
    const emp = db.prepare(
      'SELECT name FROM employees WHERE employee_id = 999'
    ).get();
    assert.equal(emp.name, '测试员工', '员工数据重启后保留');

    const inv = db.prepare(
      "SELECT stock FROM inventory_item WHERE id = 'INV-T01'"
    ).get();
    assert.equal(inv.stock, 100, '库存数据重启后保留');

    db.close();
  }

  fs.rmSync(path.dirname(p), { recursive: true });
});

test('DR-T02-03: user_version 幂等——重复调用不报错', () => {
  const p = tmpDbPath();
  const { db } = initDb(p);

  // 第二次调 runMigrations:应全部 skipped
  const results = runMigrations(db);
  assert.equal(results.length, 4);
  assert.equal(results[0].skipped, true, '001 应跳过');
  assert.equal(results[1].skipped, true, '002 应跳过');
  assert.equal(results[2].skipped, true, '003 应跳过');
  assert.equal(results[3].skipped, true, '004 应跳过');

  // user_version 不变(仍是 4)
  assert.equal(getPragmaNumber(db, 'user_version'), 4);

  db.close();
  fs.rmSync(path.dirname(p), { recursive: true });
});
