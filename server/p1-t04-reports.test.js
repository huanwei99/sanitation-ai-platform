// p1-t04-reports.test.js — P1-T04 报表:流水/低库存/发放统计
// 验收:
//   ① 库存流水:分页+筛选(item/depot/reason/date)+汇总(total_in/total_out)
//   ② 低库存告警:含 INV-004 扫帚场景(A-T11 SQL 版),critical(=0)与 warning 区分
//   ③ 发放统计:by_status/by_department/top_items,日期+仓筛选

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-test-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'rpt-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 4101, account: 'EMP4101', password: 'Pwd4101@x',
    name: 'Keeper-Rpt', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { inventory: ['view', 'edit'], distribution: ['view', 'edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 4102, account: 'EMP4102', password: 'Pwd4102@x',
    name: 'Approver-Rpt', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { distribution: ['view', 'edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 4103, account: 'EMP4103', password: 'Pwd4103@x',
    name: 'Foreman-Rpt', position: '班组长', department: '一线作业',
    permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return {
    app, dbPath,
    keeper: await login('EMP4101', 'Pwd4101@x'),
    approver: await login('EMP4102', 'Pwd4102@x'),
    foreman: await login('EMP4103', 'Pwd4103@x'),
  };
}

// 造一笔发放流转(INV-001 @DP-001,10件,1人) → 产生 stock_movement
async function seedMovement(app, cookie) {
  const r = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie, 'idempotency-key': `rpt-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 4103, department: '一线作业', scope: 'all', total_people: 10,
      depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [{ employee_id: 4103 }]
    }
  });
  assert.equal(r.statusCode, 201, `建单失败: ${r.body}`);
  return r.json().id;
}

test('P1-T04-RPT1: 库存流水 — 空库(未流转)返回 0 条,汇总 0/0', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const r = await app.inject({ method: 'GET', url: '/reports/stock-movements', headers: { cookie: keeper } });
    assert.equal(r.statusCode, 200, `流水查询应 200: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 0);
    assert.equal(body.summary.total_in, 0);
    assert.equal(body.summary.total_out, 0);
    assert.deepEqual(body.items, []);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT2: 库存流水 — 出库流转后返回流水,汇总 total_out', async () => {
  const { app, dbPath, keeper, approver, foreman } = await buildFixture();
  try {
    const id = await seedMovement(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: keeper } });

    const r = await app.inject({ method: 'GET', url: '/reports/stock-movements', headers: { cookie: keeper } });
    assert.equal(r.statusCode, 200, `流水应 200: ${r.body}`);
    const body = r.json();
    assert.equal(body.total, 1, '应 1 条流水');
    const mov = body.items[0];
    assert.equal(mov.item_id, 'INV-001');
    assert.equal(mov.delta, -10, '出库 delta=-10');
    assert.equal(mov.reason, 'distribution_out');
    assert.equal(mov.depot_id, 'DP-001');
    assert.equal(mov.qty_after, 490, '500-10=490');
    assert.equal(mov.ref_type, 'distribution');
    assert.equal(mov.ref_id, id);
    assert.equal(body.summary.total_out, 10, 'total_out 应 10');
    assert.equal(body.summary.total_in, 0);
    assert.ok(mov.item_name, '应含物资名');
    assert.ok(mov.actor_name, '应含操作人名');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT3: 库存流水 — 按 item_id/depot_id/reason 筛选', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    // INV-001 出 10
    const id1 = await seedMovement(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id1}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id1}/issue`, headers: { cookie: keeper } });

    // INV-002 出 20(新建单)
    const r2 = await app.inject({
      method: 'POST', url: '/distribution/requests',
      headers: { cookie: keeper, 'idempotency-key': `rpt2-${Date.now()}` },
      payload: {
        applicant_id: 4103, department: '一线作业', scope: 'all', total_people: 20,
        depot_id: 'DP-001',
        items: [{ item_id: 'INV-002', per_person_qty: 1 }],
        recipients: [{ employee_id: 4103 }]
      }
    });
    const id2 = r2.json().id;
    await app.inject({ method: 'POST', url: `/distribution/${id2}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id2}/issue`, headers: { cookie: keeper } });

    // 全部 → 2 条
    const all = await app.inject({ method: 'GET', url: '/reports/stock-movements', headers: { cookie: keeper } });
    assert.equal(all.json().total, 2);

    // 按 item_id=INV-001 → 1 条
    const byItem = await app.inject({
      method: 'GET', url: '/reports/stock-movements?item_id=INV-001',
      headers: { cookie: keeper }
    });
    assert.equal(byItem.json().total, 1);
    assert.equal(byItem.json().items[0].item_id, 'INV-001');

    // 按 reason=distribution_out → 2 条
    const byReason = await app.inject({
      method: 'GET', url: '/reports/stock-movements?reason=distribution_out',
      headers: { cookie: keeper }
    });
    assert.equal(byReason.json().total, 2);

    // 按 reason=inbound → 0 条
    const byIn = await app.inject({
      method: 'GET', url: '/reports/stock-movements?reason=inbound',
      headers: { cookie: keeper }
    });
    assert.equal(byIn.json().total, 0);

    // 按 depot_id=DP-002 → 0 条
    const byDepot = await app.inject({
      method: 'GET', url: '/reports/stock-movements?depot_id=DP-002',
      headers: { cookie: keeper }
    });
    assert.equal(byDepot.json().total, 0);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT4: 低库存 — 出库后 INV-003(扫帚)降至阈值下,触发告警', async () => {
  const { app, dbPath, keeper, approver, foreman } = await buildFixture();
  try {
    // 种子里 INV-003 扫帚 80/20,不低库存。造一笔大额发放,把库存降到 <= min_stock
    // 出库 65 把 → 80-65=15 <= 20 → 低库存告警
    const r = await app.inject({
      method: 'POST', url: '/distribution/requests',
      headers: { cookie: keeper, 'idempotency-key': `rpt-low-${Date.now()}` },
      payload: {
        applicant_id: 4103, department: '一线作业', scope: 'all', total_people: 65,
        depot_id: 'DP-001',
        items: [{ item_id: 'INV-003', per_person_qty: 1 }],
        recipients: [{ employee_id: 4103 }]
      }
    });
    assert.equal(r.statusCode, 201, `建单失败: ${r.body}`);
    const id = r.json().id;
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: keeper } });

    // 确认库存已降
    const stock = app.db.prepare("SELECT stock, min_stock FROM inventory_item WHERE id='INV-003' AND depot_id='DP-001'").get();
    assert.equal(stock.stock, 15, '应剩 15 把');
    assert.ok(stock.stock <= stock.min_stock, '应触发低库存');

    const r2 = await app.inject({ method: 'GET', url: '/reports/low-stock', headers: { cookie: keeper } });
    assert.equal(r2.statusCode, 200, `低库存应 200: ${r2.body}`);
    const body = r2.json();
    assert.equal(body.ok, true);
    assert.ok(body.count >= 1, `应至少 1 条低库存,实际 ${body.count}`);
    const inv003 = body.items.find(x => x.id === 'INV-003');
    assert.ok(inv003, '应含 INV-003(扫帚)');
    assert.equal(inv003.stock, 15);
    assert.equal(inv003.min_stock, 20);
    assert.equal(inv003.shortage, 5, '缺口 5');
    assert.equal(inv003.severity, 'warning', '非零库存应 warning');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT5: 低库存 — 按 depot_id 筛选,DP-002 无低库存', async () => {
  const { app, dbPath, keeper } = await buildFixture();
  try {
    const r = await app.inject({
      method: 'GET', url: '/reports/low-stock?depot_id=DP-002',
      headers: { cookie: keeper }
    });
    assert.equal(r.statusCode, 200);
    // DP-002 种子里无库存行(或无低库存项)
    assert.equal(r.json().count, 0, 'DP-002 应无低库存');
    assert.deepEqual(r.json().items, []);
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT6: 发放统计 — by_status/by_department/top_items', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    // 建+批 2 张
    const id1 = await seedMovement(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id1}/approve`, headers: { cookie: approver } });
    const r2 = await app.inject({
      method: 'POST', url: '/distribution/requests',
      headers: { cookie: keeper, 'idempotency-key': `rpt6-${Date.now()}` },
      payload: {
        applicant_id: 4103, department: '管理部', scope: 'all', total_people: 5,
        depot_id: 'DP-001',
        items: [{ item_id: 'INV-001', per_person_qty: 2 }],
        recipients: [{ employee_id: 4102 }]
      }
    });
    const id2 = r2.json().id;
    await app.inject({ method: 'POST', url: `/distribution/${id2}/approve`, headers: { cookie: approver } });

    const r = await app.inject({ method: 'GET', url: '/reports/distribution-stats', headers: { cookie: keeper } });
    assert.equal(r.statusCode, 200, `发放统计应 200: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);

    // total:2 张,15 人次,有成本
    assert.equal(body.total.count, 2, '共 2 张单');
    assert.equal(body.total.total_people, 15, '10+5=15 人次');
    assert.ok(body.total.total_cost > 0, '成本应 >0');

    // by_status:已批准 2 张
    const approved = body.by_status.find(x => x.status === '已批准');
    assert.ok(approved);
    assert.equal(approved.count, 2);

    // by_department:一线作业 1 张,管理部 1 张
    const depts = body.by_department.reduce((m, x) => (m[x.department] = x.count, m), {});
    assert.equal(depts['一线作业'], 1);
    assert.equal(depts['管理部'], 1);

    // top_items:INV-001 应在 top(出库数量统计)
    assert.ok(Array.isArray(body.top_items));
    const inv001 = body.top_items.find(x => x.item_id === 'INV-001');
    assert.ok(inv001, 'INV-001 应在 top_items');
    assert.equal(inv001.total_qty, 20, '10+2*5=20 件');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT7: 发放统计 — 按 depot_id/日期范围筛选', async () => {
  const { app, dbPath, keeper, approver } = await buildFixture();
  try {
    const id1 = await seedMovement(app, keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id1}/approve`, headers: { cookie: approver } });

    // DP-001 应有 1 张
    const byDepot = await app.inject({
      method: 'GET', url: '/reports/distribution-stats?depot_id=DP-001',
      headers: { cookie: keeper }
    });
    assert.equal(byDepot.json().total.count, 1);

    // DP-002 应 0 张
    const empty = await app.inject({
      method: 'GET', url: '/reports/distribution-stats?depot_id=DP-002',
      headers: { cookie: keeper }
    });
    assert.equal(empty.json().total.count, 0);

    // 未来日期范围 → 0 张
    const future = await app.inject({
      method: 'GET', url: '/reports/distribution-stats?from=2099-01-01&to=2099-12-31',
      headers: { cookie: keeper }
    });
    assert.equal(future.json().total.count, 0, '未来日期应 0 张');
  } finally { await cleanup(app, dbPath); }
});

test('P1-T04-RPT8: 无权限访问报表 → 403', async () => {
  const { app, dbPath, foreman } = await buildFixture();
  try {
    // foreman permissions=null,无 inventory/distribution view
    const r1 = await app.inject({ method: 'GET', url: '/reports/stock-movements', headers: { cookie: foreman } });
    assert.equal(r1.statusCode, 403, `流水应 403: ${r1.body}`);

    const r2 = await app.inject({ method: 'GET', url: '/reports/low-stock', headers: { cookie: foreman } });
    assert.equal(r2.statusCode, 403, `低库存应 403: ${r2.body}`);

    const r3 = await app.inject({ method: 'GET', url: '/reports/distribution-stats', headers: { cookie: foreman } });
    assert.equal(r3.statusCode, 403, `发放统计应 403: ${r3.body}`);
  } finally { await cleanup(app, dbPath); }
});
