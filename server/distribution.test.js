// distribution.test.js — DR-T04 验收测试
// 覆盖:创建 →审批 → 出库扣减库存+流水 → 状态推进 → 本人签收 self_only → 幂等 → 哈希链
// Fastify inject 模拟 HTTP,不起真端口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');
const { verifyDistributionChain } = require('./distribution');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-test-'));
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

// fixture:库管员 2001、审批人 2002、一线 2003
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'test-dist-secret' });
  await app.ready();
  // 迁移 004 已种库存,不需要手动塞物资

  await seedAccount(app.db, {
    employee_id: 2001, account: 'EMP2001', password: 'Pwd2001@x',
    name: '库管员-A', position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 2002, account: 'EMP2002', password: 'Pwd2002@x',
    name: '审批人-B', position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 2003, account: 'EMP2003', password: 'Pwd2003@x',
    name: '一线-C', position: '保洁员', department: '一线作业',
    permissions: null
  });

  // 登录拿 cookie(返回完整 "sid=<token>" 串,供后续请求直接用)
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  const keeper = await login('EMP2001', 'Pwd2001@x');
  const approver = await login('EMP2002', 'Pwd2002@x');
  const worker = await login('EMP2003', 'Pwd2003@x');

  return { app, dbPath, cookies: { keeper, approver, worker } };
}

// 创建一个基础发放单(库管员 → 5人领口罩和消毒液)
async function createSample(app, cookie) {
  const r = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie, 'idempotency-key': `create-${Date.now()}-${Math.random()}` },
    payload: {
      applicant_id: 2003, department: '一线作业',
      scope: 'all', total_people: 5, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 2 }, { item_id: 'INV-004', per_person_qty: 1 }],
      recipients: [{ employee_id: 2003, units: 'A班', people_count: 5 }]
    }
  });
  assert.equal(r.statusCode, 201, `创建失败: ${r.body}`);
  return r.json();
}

test('DR-T04-01: 创建发放单 → 待审批,链上 step_started', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const body = await createSample(app, cookies.keeper);
    assert.equal(body.ok, true);
    assert.equal(body.status, '待审批');
    assert.ok(body.id.startsWith('MD-'), `单号应 MD-xxx: ${body.id}`);
    assert.equal(body.lines, 2);

    const db = app.db;
    const dist = db.prepare('SELECT * FROM distribution WHERE id = ?').get(body.id);
    assert.equal(dist.status, '待审批');
    assert.equal(dist.current_step, 0);
    assert.equal(dist.approval_id, null);
    assert.equal(dist.total_cost, 2 * 5 * 800 + 1 * 5 * 600);   // 口罩 800分/包 × 2 × 5 + 手套 600分/盒 × 1 × 5

    const chain = verifyDistributionChain(db, body.id);
    assert.equal(chain.ok, true);
    assert.equal(chain.events, 1);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-02: 未审批不能出库(审批强制前置)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const { id } = await createSample(app, cookies.keeper);
    // 直接尝试出库 → 400
    const issueRes = await app.inject({
      method: 'POST', url: `/distribution/${id}/issue`,
      headers: { cookie: cookies.keeper }
    });
    assert.equal(issueRes.statusCode, 400, '未审批应 400');
    assert.match(issueRes.json().error, /未审批|应待审批/);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-03: 审批成功 → 已批准 + 链上 approval_granted + 自审被拒', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const { id } = await createSample(app, cookies.keeper);
    // 发放人自审 → 403
    const self = await app.inject({
      method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.keeper }
    });
    assert.equal(self.statusCode, 403, '自审应 403');
    // 审批人通过
    const ok = await app.inject({
      method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver }
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().status, '已批准');
    assert.ok(ok.json().approval_id);
    const db = app.db;
    const dist = db.prepare('SELECT approval_id, status FROM distribution WHERE id = ?').get(id);
    assert.equal(dist.status, '已批准');
    assert.equal(dist.approval_id, ok.json().approval_id);
    const chain = verifyDistributionChain(db, id);
    assert.equal(chain.events, 2);   // create + approve
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-04: 出库扣减库存 + 写 stock_movement + 状态 → 发放中', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const { id } = await createSample(app, cookies.keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });

    // 出库前库存
    const db = app.db;
    const before1 = db.prepare('SELECT stock FROM inventory_item WHERE id = ?').get('INV-001').stock;
    const before4 = db.prepare('SELECT stock FROM inventory_item WHERE id = ?').get('INV-004').stock;

    const issueRes = await app.inject({
      method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper }
    });
    assert.equal(issueRes.statusCode, 200, `出库失败: ${issueRes.body}`);
    assert.equal(issueRes.json().status, '发放中');
    assert.equal(issueRes.json().step, 1);

    // 库存已扣减
    const after1 = db.prepare('SELECT stock FROM inventory_item WHERE id = ?').get('INV-001').stock;
    const after4 = db.prepare('SELECT stock FROM inventory_item WHERE id = ?').get('INV-004').stock;
    assert.equal(after1, before1 - 10);  // 2 × 5
    assert.equal(after4, before4 - 5);   // 1 × 5

    // 流水已写
    const mov = db.prepare(
      `SELECT * FROM stock_movement WHERE ref_type = 'distribution' AND ref_id = ? ORDER BY line_no`
    ).all(id);
    assert.equal(mov.length, 2);
    assert.equal(mov[0].delta, -10);
    assert.equal(mov[0].reason, 'distribution_out');
    assert.equal(mov[0].qty_after, after1);
    assert.equal(mov[0].depot_id, 'DP-001');

    const chain = verifyDistributionChain(db, id);
    assert.equal(chain.events, 3);   // create + approve + stock_deducted
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-05 (A-T2): 库存不足 → 409 + item_id/available/requested,库存与流水不变', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const db = app.db;
    // 对齐 A-T2 规格:把 INV-004 改到 stock=15(规格值)
    db.prepare('UPDATE inventory_item SET stock = 15 WHERE id = ?').run('INV-004');

    // 创建 10 人 × 手套 2 盒 = 20 > 15
    const over = await app.inject({
      method: 'POST', url: '/distribution/requests',
      headers: { cookie: cookies.keeper, 'idempotency-key': `over-${Date.now()}` },
      payload: {
        applicant_id: 2003, total_people: 10, depot_id: 'DP-001',
        items: [{ item_id: 'INV-004', per_person_qty: 2 }],
        recipients: [{ employee_id: 2003, units: 'A班', people_count: 10 }]
      }
    });
    assert.equal(over.statusCode, 201);
    const { id } = over.json();
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });

    const movBefore = db.prepare('SELECT COUNT(*) AS c FROM stock_movement').get().c;

    const issueRes = await app.inject({
      method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper }
    });
    // A-T2: 409 + 点名 INV-004 + available/requested
    assert.equal(issueRes.statusCode, 409, `库存不足应 409: ${issueRes.body}`);
    const body = issueRes.json();
    assert.equal(body.item_id, 'INV-004', `响应应点名 INV-004: ${JSON.stringify(body)}`);
    assert.equal(body.available, 15, `available 应为 15: ${JSON.stringify(body)}`);
    assert.equal(body.requested, 20, `requested 应为 20: ${JSON.stringify(body)}`);

    // 库存/流水未变(事务回滚)
    const after = db.prepare('SELECT stock FROM inventory_item WHERE id = ?').get('INV-004').stock;
    assert.equal(after, 15, '库存应回滚不变');
    const movAfter = db.prepare('SELECT COUNT(*) AS c FROM stock_movement').get().c;
    assert.equal(movAfter, movBefore, '流水条数应不变');
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-06: 幂等键 — 相同 Idempotency-Key 重放返回同一响应', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const key = 'idem-create-001';
    const payload = {
      applicant_id: 2003, total_people: 2, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }]
    };
    const r1 = await app.inject({
      method: 'POST', url: '/distribution/requests',
      headers: { cookie: cookies.keeper, 'idempotency-key': key },
      payload
    });
    assert.equal(r1.statusCode, 201);
    const id1 = r1.json().id;

    const r2 = await app.inject({
      method: 'POST', url: '/distribution/requests',
      headers: { cookie: cookies.keeper, 'idempotency-key': key },
      payload
    });
    assert.equal(r2.statusCode, 201);
    assert.equal(r2.json().id, id1, '幂等重放应返回同一 id');
    // 库里只应有 1 张单
    const cnt = app.db.prepare("SELECT COUNT(*) AS c FROM distribution WHERE id = ?").get(id1).c;
    assert.equal(cnt, 1);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-07: 完整流程 — step1→transfer→receive→step4 全链闭环 + 哈希链 ok', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const { id } = await createSample(app, cookies.keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper } });

    // 班组移交(给一线 2003)
    const tr = await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie: cookies.keeper },
      payload: { recipient_id: 2003 }
    });
    assert.equal(tr.statusCode, 200, `移交失败: ${tr.body}`);
    assert.equal(tr.json().status, '已移交');

    // 本人签收(2003 自己登录)
    const rec = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: cookies.worker }
    });
    assert.equal(rec.statusCode, 200, `签收失败: ${rec.body}`);
    assert.equal(rec.json().received_by, 2003);

    // 推进到 step4
    const a2 = await app.inject({
      method: 'POST', url: `/distribution/${id}/advance`,
      headers: { cookie: cookies.keeper }, payload: { step: 2 }
    });
    assert.equal(a2.statusCode, 200);
    const a3 = await app.inject({
      method: 'POST', url: `/distribution/${id}/advance`,
      headers: { cookie: cookies.keeper }, payload: { step: 3 }
    });
    assert.equal(a3.statusCode, 200);
    const a4 = await app.inject({
      method: 'POST', url: `/distribution/${id}/advance`,
      headers: { cookie: cookies.keeper }, payload: { step: 4 }
    });
    assert.equal(a4.statusCode, 200);
    assert.equal(a4.json().status, '已完成');

    const db = app.db;
    const dist = db.prepare('SELECT status, current_step FROM distribution WHERE id = ?').get(id);
    assert.equal(dist.status, '已完成');
    assert.equal(dist.current_step, 4);

    // 哈希链完整
    const chain = verifyDistributionChain(db, id);
    assert.equal(chain.ok, true, `哈希链应完整: ${JSON.stringify(chain)}`);
    // 事件数:step_started + approval_granted + stock_deducted + transfer + signoff + step_completed(step2) + step3 + step4 = 8
    assert.equal(chain.events, 8);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T04-08: self_only — 非本人签收被拒', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const { id } = await createSample(app, cookies.keeper);
    await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });
    await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper } });
    await app.inject({
      method: 'POST', url: `/distribution/${id}/transfer`,
      headers: { cookie: cookies.keeper }, payload: { recipient_id: 2003 }
    });
    // 库管员 2001 想替一线 2003 签收 → 403
    const other = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: cookies.keeper }
    });
    assert.equal(other.statusCode, 403, '非本人应 403');
    assert.match(other.json().error, /self_only|仅申请人|接收人本人/);

    // 接收人本人签 → 200
    const self = await app.inject({
      method: 'POST', url: `/distribution/${id}/receive`,
      headers: { cookie: cookies.worker }
    });
    assert.equal(self.statusCode, 200);
  } finally { await cleanup(app, dbPath); }
});