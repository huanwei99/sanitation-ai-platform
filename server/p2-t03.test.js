// p2-t03.test.js — P2-T03 清雪应急指挥调度模块
// 验收:
//   ① 五阶段状态机合法转移:alert→verified→activated→executing→resolved,逐级推进
//   ② 非法转移被拒绝(跳级/逆流/终态再转)→ 409
//   ③ 外租+自有设备混合调度:自有车辆 + 外租车辆 + 人员,均可调度;重复调度冲突
//   ④ 战报自动生成:Markdown 含人员/车辆/物资/路段;幂等(内容确定)
//   ⑤ 审计链:verifyChain(db,'emergency',id) 校验通过

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');
const { verifyChain } = require('./chain');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emg-p2t03-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'emg-p2t03-secret' });
  await app.ready();

  await seedAccount(app.db, {
    employee_id: 9005, account: 'DRILL-COMMANDER', password: 'Aa@123456',
    name: '演练-应急指挥员', position: '应急指挥员', department: '应急指挥中心',
    permissions: { mode: 'manual', level: 4, scope: 'group',
      modules: { emergency: ['view', 'edit', 'dispatch', 'resolve'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 9004, account: 'DRILL-WORKER', password: 'Aa@123456',
    name: '演练-一线员工', position: '保洁员', department: '一线作业', permissions: null
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }

  // 造一条外租设备(合同 + 明细),供外租调度用
  const ownItem = app.db.prepare(
    "SELECT id FROM inventory_item WHERE is_rented = 0 ORDER BY id LIMIT 1"
  ).get();
  app.db.prepare(
    `INSERT INTO rental_contract (id, supplier, department, depot_id, start_date, status, created_by)
     VALUES ('RC-TEST-001','外租公司','应急中心','DP-001','2026-11-17','active',9005)`
  ).run();
  app.db.prepare(
    `INSERT INTO rental_item (contract_id, item_id, serial_no, qty, day_rate, status)
     VALUES ('RC-TEST-001', ?, 'XG-001', 1, 800, 'rented')`
  ).run(ownItem.id);
  const rentedItem = app.db.prepare("SELECT id FROM rental_item WHERE contract_id='RC-TEST-001'").get();

  const commander = await login('DRILL-COMMANDER', 'Aa@123456');
  const worker = await login('DRILL-WORKER', 'Aa@123456');

  const post = (url, payload) => app.inject({
    method: 'POST', url, headers: { cookie: commander, 'Content-Type': 'application/json' },
    payload: payload || {}
  });

  return {
    app, dbPath,
    commander,
    worker,
    ownItemId: ownItem.id,
    rentedItemId: rentedItem.id,
    workerId: 9004,
    post
  };
}

// 创建事件并推进到指定状态(默认 executing)
async function createAndAdvance(fx, target = 'executing') {
  const order = ['verified', 'activated', 'executing', 'resolved'];
  const create = await fx.post('/emergency/events', {
    plan_id: 'EP-SNOW', title: '11·17 暴雪清雪', category: 'snow', level: 'II',
    situation: { roads_affected: ['中山路', '解放路'], snow_depth: 15 }
  });
  assert.equal(create.statusCode, 201, `创建事件失败: ${create.body}`);
  const eid = create.json().event.id;
  const need = order.slice(0, order.indexOf(target) + 1);
  for (const to of need) {
    const t = await fx.post(`/emergency/events/${eid}/transition`, { to, note: '推进' });
    assert.equal(t.statusCode, 200, `推进到 ${to} 失败: ${t.body}`);
  }
  return eid;
}

test('P2-T03-SM1: 五阶段状态机 — 合法逐级转移 alert→verified→activated→executing→resolved', async () => {
  const fx = await buildFixture();
  const { app, dbPath } = fx;
  try {
    const create = await fx.post('/emergency/events', {
      plan_id: 'EP-SNOW', title: '状态机全链路', category: 'snow', level: 'III'
    });
    assert.equal(create.statusCode, 201);
    const eid = create.json().event.id;
    assert.equal(create.json().event.status, 'alert', '新建事件应为 alert');

    // 逐级推进
    const path = [['verified', '已核实'], ['activated', '已启动'], ['executing', '执行中'], ['resolved', '已结案']];
    for (const [to, label] of path) {
      const r = await fx.post(`/emergency/events/${eid}/transition`, { to, note: '推进' });
      assert.equal(r.statusCode, 200, `推进到 ${to} 应 200: ${r.body}`);
      assert.equal(r.json().event.status, to, `状态应为 ${to}`);
    }
    // 终态:end_time 已写
    const detail = await app.inject({ method:'GET', url:`/emergency/events/${eid}`, headers:{cookie:fx.commander} });
    assert.equal(detail.json().detail.event.status, 'resolved');
    assert.ok(detail.json().detail.event.end_time, '结案应写结束时间');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T03-SM2: 非法转移被拒绝 — 跳级/逆流/终态再转', async () => {
  const fx = await buildFixture();
  const { app, dbPath } = fx;
  try {
    const create = await fx.post('/emergency/events', {
      plan_id: 'EP-SNOW', title: '非法转移', category: 'snow', level: 'III'
    });
    const eid = create.json().event.id;

    // alert 直接 → resolved(跳级)→ 409
    let r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'resolved' });
    assert.equal(r.statusCode, 409, `alert→resolved 应 409: ${r.body}`);

    // alert → executing(跳级)→ 409
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'executing' });
    assert.equal(r.statusCode, 409, `alert→executing 应 409: ${r.body}`);

    // 合法推进到 executing
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'verified' });
    assert.equal(r.statusCode, 200);
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'activated' });
    assert.equal(r.statusCode, 200);
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'executing' });
    assert.equal(r.statusCode, 200);

    // executing → activated(逆流)→ 409
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'activated' });
    assert.equal(r.statusCode, 409, `executing→activated 逆流应 409: ${r.body}`);

    // 结案后再转 → 409
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'resolved' });
    assert.equal(r.statusCode, 200);
    r = await fx.post(`/emergency/events/${eid}/transition`, { to: 'executing' });
    assert.equal(r.statusCode, 409, `resolved 终态再转应 409: ${r.body}`);
  } finally { await cleanup(app, dbPath); }
});

test('P2-T03-DS1: 混合调度 — 自有车辆 + 外租车辆 + 人员', async () => {
  const fx = await buildFixture();
  const { app, dbPath } = fx;
  try {
    const eid = await createAndAdvance(fx, 'executing');

    // 自有车辆
    let r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'own', inventory_item_id: fx.ownItemId,
      assigned_role: '铲雪车', area: '中山路'
    });
    assert.equal(r.statusCode, 201, `自有车辆调度应 201: ${r.body}`);
    assert.equal(r.json().dispatch.source, 'own');
    assert.ok(r.json().dispatch.resource_name, '应回填资源名');

    // 外租车辆
    r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'rented', rental_item_id: fx.rentedItemId,
      assigned_role: '铲雪车', area: '解放路'
    });
    assert.equal(r.statusCode, 201, `外租车辆调度应 201: ${r.body}`);
    assert.equal(r.json().dispatch.source, 'rented');

    // 人员
    r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'personnel', employee_id: fx.workerId,
      assigned_role: '铲雪', area: '中山路'
    });
    assert.equal(r.statusCode, 201, `人员调度应 201: ${r.body}`);

    // 详情应含 3 条调度
    const detail = await app.inject({ method:'GET', url:`/emergency/events/${eid}`, headers:{cookie:fx.commander} });
    const d = detail.json().detail;
    assert.equal(d.dispatches.length, 3, '应有 3 条调度');
    assert.equal(d.dispatches.filter(x => x.source === 'own').length, 2, '自有 2');
    assert.equal(d.dispatches.filter(x => x.source === 'rented').length, 1, '外租 1');
  } finally { await cleanup(app, dbPath); }
});

test('P2-T03-DS2: 资源可用性校验 — 重复调度冲突 + 人员停用', async () => {
  const fx = await buildFixture();
  const { app, dbPath } = fx;
  try {
    const eid = await createAndAdvance(fx, 'executing');

    // 同一自有车辆调度两次 → 冲突(409)
    let r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'own', inventory_item_id: fx.ownItemId
    });
    assert.equal(r.statusCode, 201);
    r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'own', inventory_item_id: fx.ownItemId
    });
    assert.equal(r.statusCode, 409, `同资源重复调度应 409: ${r.body}`);

    // 同一人员重复调度 → 人员允许多任务(合法,不冲突)
    r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'personnel', employee_id: fx.workerId
    });
    assert.equal(r.statusCode, 201, `人员多任务调度应允许 201: ${r.body}`);

    // 停用员工 → 冲突
    app.db.prepare('UPDATE employees SET is_active = 0 WHERE employee_id = ?').run(9004);
    r = await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'personnel', employee_id: 9004
    });
    assert.equal(r.statusCode, 409, `停用人员调度应 409: ${r.body}`);
  } finally { await cleanup(app, dbPath); }
});

test('P2-T03-BR1: 战报自动生成 — 内容完整 + 幂等', async () => {
  const fx = await buildFixture();
  const { app, dbPath } = fx;
  try {
    const eid = await createAndAdvance(fx, 'executing');
    await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'own', inventory_item_id: fx.ownItemId, area: '中山路'
    });
    await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'rented', rental_item_id: fx.rentedItemId, area: '解放路'
    });
    await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'personnel', employee_id: fx.workerId, assigned_role: '铲雪'
    });
    await fx.post(`/emergency/events/${eid}/progress`, { action: '中山路清理完成', detail: '已清理' });
    await fx.post(`/emergency/events/${eid}/resolve`, { summary: { roads_cleared: ['中山路', '解放路'], note: '完成' } });

    // 生成战报
    let r = await fx.post(`/emergency/events/${eid}/battle-report`);
    assert.equal(r.statusCode, 200, `生成战报应 200: ${r.body}`);
    const report = r.json().report;
    assert.ok(report.content, '应有战报内容');
    assert.equal(report.format, 'markdown');

    // 内容含关键段
    const c = report.content;
    assert.ok(c.indexOf('# 清雪应急战报') === 0, '应以战报标题开头');
    assert.ok(c.indexOf('## 投入人员') !== -1, '含投入人员');
    assert.ok(c.indexOf('## 投入车辆') !== -1, '含投入车辆');
    assert.ok(c.indexOf('## 投入物资') !== -1, '含投入物资');
    assert.ok(c.indexOf('## 路段') !== -1, '含路段');
    assert.ok(c.indexOf('自有') !== -1 && c.indexOf('外租') !== -1, '区分自有/外租');
    assert.ok(c.indexOf('中山路') !== -1 && c.indexOf('解放路') !== -1, '含路段名');

    // 幂等:再次生成内容一致
    const r2 = await fx.post(`/emergency/events/${eid}/battle-report`);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().report.content, c, '重复生成战报内容应一致(确定性)');

    // GET 也可取
    const g = await app.inject({ method:'GET', url:`/emergency/events/${eid}/battle-report`, headers:{cookie:fx.commander} });
    assert.equal(g.statusCode, 200);
    assert.equal(g.json().report.content, c);
  } finally { await cleanup(app, dbPath); }
});

test('P2-T03-CH1: 审计链 — verifyChain 校验通过', async () => {
  const fx = await buildFixture();
  const { app, dbPath } = fx;
  try {
    const eid = await createAndAdvance(fx, 'executing');
    await fx.post(`/emergency/events/${eid}/dispatch`, {
      resource_type: 'vehicle', source: 'own', inventory_item_id: fx.ownItemId
    });
    await fx.post(`/emergency/events/${eid}/progress`, { action: '推进', detail: 'x' });
    await fx.post(`/emergency/events/${eid}/resolve`, { summary: { note: 'done' } });
    await fx.post(`/emergency/events/${eid}/battle-report`);

    const v = verifyChain(app.db, 'emergency', String(eid));
    assert.equal(v.ok, true, `审计链应完整: ${JSON.stringify(v)}`);
    assert.ok(v.events >= 5, `链事件数应 ≥5(创建+4转移+调度+进度+结案+战报),实际 ${v.events}`);
  } finally { await cleanup(app, dbPath); }
});
