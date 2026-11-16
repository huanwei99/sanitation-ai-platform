// concurrency-at7.test.js — A-T7 服务端层:并发 step1(仓库出库)不超卖(I1 补口)
//
// 背景:I1 指出 A-T7(并发 step1 不超卖)此前只在 foundation 的内存引擎里测过,
//      server/SQL 层从未覆盖 —— 而「防超卖」正是本产品的卖点之一。
// 本测试在真 SQLite 上跑:同一物资仅剩 N 份,两个已审批单据并发请求出库各 N 份,
// 断言:恰好一个 200、另一个 409;最终 stock 与 stock_movement 完全一致(不超卖、不少记)。
//
// 说明:better-sqlite3 为同步引擎,同一连接上注入的请求天然串行;真正的并发安全来自
//      distribution.js 出库路径在「单事务 + 守卫式 UPDATE ... WHERE stock >= ?」内完成
//      「校验+扣减+写流水」。本测试用「剩余库存恰好等于单份需求」的边界制造冲突,
//      无论两次注入的交错顺序如何,守卫式 UPDATE 都保证只有第一次成功、第二次 409。
//      (这验证的是不变量,而非特定调度;内存版 A-T7 亦是同一不变量。)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at7-conc-'));
  return path.join(dir, 'test.db');
}
async function cleanup(app, dbPath) {
  try { await app.close(); } catch {}
  const dir = path.dirname(dbPath);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise(r => setTimeout(r, 100 * (i + 1))); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'at7-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 7001, account: 'EMP7001', password: 'Pwd7001@x', name: '库管',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 7002, account: 'EMP7002', password: 'Pwd7002@x', name: '审批',
    position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  async function login(a, p) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account: a, password: p } });
    assert.equal(r.statusCode, 200, `登录失败 ${a}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return { app, dbPath, cookies: { keeper: await login('EMP7001', 'Pwd7001@x'), approver: await login('EMP7002', 'Pwd7002@x') } };
}

// 建单 + 审批(不出库),返回单号。qty = per_person_qty * total_people
async function createAndApprove(app, cookies, { totalPeople, perPerson, tag }) {
  const create = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie: cookies.keeper, 'idempotency-key': `at7-${tag}-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 7001, total_people: totalPeople, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: perPerson }],
      recipients: [{ employee_id: 7002, units: 'A班', people_count: totalPeople }]
    }
  });
  assert.equal(create.statusCode, 201, `创建失败: ${create.body}`);
  const id = create.json().id;
  const approve = await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });
  assert.equal(approve.statusCode, 200, `审批失败: ${approve.body}`);
  return id;
}

test('A-T7: 并发 step1 出库不超卖 —— 恰好一个成功,另一 409,库存与流水一致', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const db = app.db;
    // 边界:库存恰好 = 一份需求量。两单各要 60,库存只够 1 单 → 必然冲突。
    const DEMAND = 60;            // 每单 60 份(per_person_qty=6 × total_people=10)
    db.prepare('UPDATE inventory_item SET stock = ? WHERE id = ?').run(DEMAND, 'INV-001');

    // 两个已审批单据(均未出库)
    const idA = await createAndApprove(app, cookies, { totalPeople: 10, perPerson: 6, tag: 'A' });
    const idB = await createAndApprove(app, cookies, { totalPeople: 10, perPerson: 6, tag: 'B' });

    // 并发请求出库(同一连接上注入;守卫式 UPDATE 保证只有第一次成功)
    const [resA, resB] = await Promise.all([
      app.inject({ method: 'POST', url: `/distribution/${idA}/issue`, headers: { cookie: cookies.keeper, 'idempotency-key': 'at7-issue-A' } }),
      app.inject({ method: 'POST', url: `/distribution/${idB}/issue`, headers: { cookie: cookies.keeper, 'idempotency-key': 'at7-issue-B' } })
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort();
    // 恰好一成一败,败者为 409
    assert.deepEqual(codes, [200, 409],
      `应恰好一个 200 一个 409,实为 A=${resA.statusCode} B=${resB.statusCode}`);

    // 失败响应体须指明 item + available/requested(对齐 A-T2 契约)
    const failedBody = resA.statusCode === 409 ? resA.json() : resB.json();
    assert.match(failedBody.error, /库存不足|stock/i);
    assert.equal(failedBody.item_id ?? failedBody.details?.item_id, 'INV-001');

    // 最终库存 = 0(只扣一次,不超卖);且非负
    const finalStock = db.prepare('SELECT stock FROM inventory_item WHERE id = ?').get('INV-001').stock;
    assert.equal(finalStock, 0, `库存应恰好扣到 0,实为 ${finalStock}`);
    assert.ok(finalStock >= 0, '库存不得为负(超卖)');

    // stock_movement 仅一条扣减流水,qty_after 与最终库存一致
    const winner = resA.statusCode === 200 ? idA : idB;
    const moves = db.prepare(
      `SELECT delta, qty_after FROM stock_movement WHERE ref_type='distribution' AND ref_id = ? ORDER BY line_no`
    ).all(winner);
    assert.equal(moves.length, 1, '只应写入一条扣减流水');
    assert.equal(moves[0].delta, -DEMAND);
    assert.equal(moves[0].qty_after, 0, '流水 qty_after 应等于最终库存');

    // 成功单状态推进到「发放中」,失败单不得推进(仍「已批准」)
    const winStatus = db.prepare('SELECT status FROM distribution WHERE id = ?').get(winner).status;
    assert.equal(winStatus, '发放中');
    const loser = resA.statusCode === 200 ? idB : idA;
    const loseStatus = db.prepare('SELECT status FROM distribution WHERE id = ?').get(loser).status;
    assert.equal(loseStatus, '已批准', `失败单不应推进,实为 ${loseStatus}`);

    // stock_movement 全表只有一条(无隐藏扣减)
    const totalMoves = db.prepare(`SELECT COUNT(*) AS n FROM stock_movement WHERE item_id='INV-001'`).get().n;
    assert.equal(totalMoves, 1, `INV-001 全表流水应只有 1 条,实为 ${totalMoves}`);
  } finally { await cleanup(app, dbPath); }
});
