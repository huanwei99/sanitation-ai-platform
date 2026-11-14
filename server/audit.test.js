// audit.test.js — DR-T06 验收测试(A-T10)
// 核心验收:走完链路 verifyChain=true;篡改中间事件后=false。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
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
  const app = await buildApp({ dbPath, cookieSecret: 'audit-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 3001, account: 'EMP3001', password: 'Pwd3001@x', name: '库管-A',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 3002, account: 'EMP3002', password: 'Pwd3002@x', name: '审批-B',
    position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 3003, account: 'EMP3003', password: 'Pwd3003@x', name: '一线-C',
    position: '保洁员', department: '一线作业', permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  const keeper = await login('EMP3001', 'Pwd3001@x');
  const approver = await login('EMP3002', 'Pwd3002@x');
  const worker = await login('EMP3003', 'Pwd3003@x');
  return { app, dbPath, cookies: { keeper, approver, worker } };
}

// 走完一次完整链路,返回单号
async function runFullChain(app, cookies) {
  const idem = `audit-${Date.now()}-${Math.random()}`;
  const create = await app.inject({
    method: 'POST', url: '/distribution/requests',
    headers: { cookie: cookies.keeper, 'idempotency-key': idem },
    payload: { applicant_id: 3003, total_people: 2, depot_id: 'DP-001',
      items: [{ item_id: 'INV-001', per_person_qty: 1 }],
      recipients: [{ employee_id: 3003, units: 'A班', people_count: 2 }] }
  });
  const id = create.json().id;
  await app.inject({ method: 'POST', url: `/distribution/${id}/approve`, headers: { cookie: cookies.approver } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/issue`, headers: { cookie: cookies.keeper } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/transfer`, headers: { cookie: cookies.keeper }, payload: { recipient_id: 3003 } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/receive`, headers: { cookie: cookies.worker } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: cookies.keeper }, payload: { step: 2 } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: cookies.keeper }, payload: { step: 3 } });
  await app.inject({ method: 'POST', url: `/distribution/${id}/advance`, headers: { cookie: cookies.keeper }, payload: { step: 4 } });
  return id;
}

test('DR-T06-01 (A-T10a): 走完链路 /audit/chain → verifyChain ok=true', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await runFullChain(app, cookies);
    const res = await app.inject({
      method: 'GET', url: `/audit/chain?ref_type=distribution&ref_id=${id}`,
      headers: { cookie: cookies.approver }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `接口失败: ${res.body}`);
    assert.equal(body.verify_ok ?? body.ok, true);
    // 单链校验结果:ok + events > 0 + head 有值
    assert.equal(body.events > 0, true);
    assert.ok(body.head, 'head 应有值');
  } finally { await cleanup(app, dbPath); }
});

test('DR-T06-02 (A-T10a): 走完链路 verify-all → all_ok=true, broken=0', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    await runFullChain(app, cookies);
    const res = await app.inject({
      method: 'GET', url: '/audit/verify-all', headers: { cookie: cookies.approver }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.all_ok, true, '全库链应完整');
    assert.equal(body.broken, 0);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T06-03 (A-T10b): 篡改中间事件的 payload → verifyChain ok=false', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await runFullChain(app, cookies);
    // 篡改:直接 UPDATE 中间事件的 payload(绕过 API,模拟 DB 层被改)
    const db = app.db;
    const evts = db.prepare(`SELECT id FROM chain_event WHERE ref_type='distribution' AND ref_id=? ORDER BY id`).all(id);
    const mid = evts[2];  // 第 3 个事件
    db.prepare(`UPDATE chain_event SET payload = ? WHERE id = ?`).run('{"tampered":true}', mid.id);

    const res = await app.inject({
      method: 'GET', url: `/audit/chain?ref_type=distribution&ref_id=${id}`,
      headers: { cookie: cookies.approver }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.verify_ok ?? body.ok, false, '篡改后链应断裂');
    assert.equal(body.broken_at, mid.id, `broken_at 应指向被改事件 ${mid.id},实为 ${body.broken_at}`);
    assert.match(body.reason, /篡改|不匹配/);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T06-04 (A-T10b): 篡改中间事件 → verify-all broken>0', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await runFullChain(app, cookies);
    const db = app.db;
    const evts = db.prepare(`SELECT id FROM chain_event WHERE ref_type='distribution' AND ref_id=? ORDER BY id`).all(id);
    // 篡改 step_no(无外键约束,参与哈希计算)→ 重算哈希不匹配 → 链断裂
    db.prepare(`UPDATE chain_event SET step_no = 99 WHERE id = ?`).run(evts[1].id);
    const res = await app.inject({
      method: 'GET', url: '/audit/verify-all', headers: { cookie: cookies.approver }
    });
    const body = res.json();
    assert.equal(body.all_ok, false, '篡改后全库不应 ok');
    assert.equal(body.broken > 0, true);
  } finally { await cleanup(app, dbPath); }
});

test('DR-T06-05: /audit/events 按单号查询事件序列(有序 + 关键事件齐全)', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const id = await runFullChain(app, cookies);
    const res = await app.inject({
      method: 'GET', url: `/audit/events?ref_type=distribution&ref_id=${id}`,
      headers: { cookie: cookies.approver }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 8, '完整链路应 8 个事件');
    // 事件类型齐全(顺序按 id 升序)
    const evts = body.events.map(e => e.event);
    assert.ok(evts.includes('step_started'), '应有 step_started');
    assert.ok(evts.includes('approval_granted'), '应有 approval_granted');
    assert.ok(evts.includes('stock_deducted'), '应有 stock_deducted');
    assert.ok(evts.includes('transfer'), '应有 transfer');
    assert.ok(evts.includes('signoff'), '应有 signoff');
    // id 严格递增(有序)
    for (let i = 1; i < body.events.length; i++) {
      assert.ok(body.events[i].id > body.events[i-1].id);
    }
    // 哈希链在每条事件里都体现:每条 prev_event_hash = 前一条 event_hash
    for (let i = 1; i < body.events.length; i++) {
      assert.equal(body.events[i].prev_event_hash, body.events[i-1].event_hash);
    }
  } finally { await cleanup(app, dbPath); }
});

test('DR-T06-06: 未登录 /audit/* 全部 401', async () => {
  const { app, dbPath } = await buildFixture();
  try {
    for (const url of ['/audit/events', '/audit/chain?ref_type=distribution&ref_id=x', '/audit/verify-all']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, `${url} 未登录应 401`);
    }
  } finally { await cleanup(app, dbPath); }
});