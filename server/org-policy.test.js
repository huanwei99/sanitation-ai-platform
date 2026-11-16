// org-policy.test.js — P0-T02 org_policy 服务 + API
// 验收:策略改动即时生效(无需重启);非管理员 403。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount } = require('./auth');
const { getPolicy, setPolicy, listPolicies, clearCache } = require('./org-policy');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-test-'));
  return path.join(dir, 'test.db');
}
async function cleanup(app, dbPath) {
  clearCache();
  try { await app.close(); } catch {}
  const dir = path.dirname(dbPath);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { await new Promise(r => setTimeout(r, 100 * (i + 1))); }
  }
}

async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'pol-secret' });
  await app.ready();
  await seedAccount(app.db, {
    employee_id: 8001, account: 'EMP8001', password: 'Pwd8001@x', name: 'Admin',
    position: '总部管理员', department: '总部',
    permissions: { mode: 'manual', level: 5, scope: 'group', modules: {}, admin_level: 1 }
  });
  await seedAccount(app.db, {
    employee_id: 8002, account: 'EMP8002', password: 'Pwd8002@x', name: 'Worker',
    position: '保洁员', department: '一线',
    permissions: null
  });
  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  return { app, dbPath, cookies: { admin: await login('EMP8001', 'Pwd8001@x'), worker: await login('EMP8002', 'Pwd8002@x') } };
}

test('T02-01: getPolicy 读 + setPolicy 写 + 即时生效', () => {
  // 用真实迁移后的库验证:distribution.require_approval 默认为 'true'
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'foundation', 'migrations', '001_init.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'foundation', 'migrations', '006_proxy_signoff.sql'), 'utf8'));

  clearCache();
  assert.equal(getPolicy(db, 'distribution.require_approval', 'false'), 'true');

  // 改值 → 下次读即时拿到新值(无需重启)
  setPolicy(db, 'distribution.require_approval', 'false');
  assert.equal(getPolicy(db, 'distribution.require_approval'), 'false');

  // 还原
  setPolicy(db, 'distribution.require_approval', 'true');
  assert.equal(getPolicy(db, 'distribution.require_approval'), 'true');
  db.close();
});

test('T02-02: listPolicies 列出全部', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'foundation', 'migrations', '001_init.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'foundation', 'migrations', '006_proxy_signoff.sql'), 'utf8'));
  clearCache();
  const list = listPolicies(db);
  assert.ok(list.length >= 4, `应至少 4 条策略,实际 ${list.length}`);
  assert.ok(list.find(p => p.key === 'distribution.require_approval'));
  db.close();
});

test('T02-03: GET /org-policy 管理员成功;非管理员 403', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const ok = await app.inject({ method: 'GET', url: '/org-policy', headers: { cookie: cookies.admin } });
    assert.equal(ok.statusCode, 200);
    assert.ok(Array.isArray(ok.json().policies));

    const deny = await app.inject({ method: 'GET', url: '/org-policy', headers: { cookie: cookies.worker } });
    assert.equal(deny.statusCode, 403);
  } finally { await cleanup(app, dbPath); }
});

test('T02-04: PUT /org-policy/:key 修改即时生效', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 改 signoff.proxy_positions
    const r = await app.inject({
      method: 'PUT', url: '/org-policy/signoff.proxy_positions',
      headers: { cookie: cookies.admin }, payload: { value: '班组长,车队长,队长,主管' }
    });
    assert.equal(r.statusCode, 200, `修改应 200: ${r.body}`);
    assert.equal(r.json().value, '班组长,车队长,队长,主管');
    assert.equal(r.json().now, '班组长,车队长,队长,主管');

    // 即时生效:直接读服务层拿到新值
    assert.equal(getPolicy(app.db, 'signoff.proxy_positions'), '班组长,车队长,队长,主管');

    // 还原
    await app.inject({
      method: 'PUT', url: '/org-policy/signoff.proxy_positions',
      headers: { cookie: cookies.admin }, payload: { value: '班组长,车队长,队长' }
    });

    // 非管理员 403
    const deny = await app.inject({
      method: 'PUT', url: '/org-policy/signoff.proxy_positions',
      headers: { cookie: cookies.worker }, payload: { value: 'x' }
    });
    assert.equal(deny.statusCode, 403);

    // 不存在的键 404
    const nf = await app.inject({
      method: 'PUT', url: '/org-policy/no.such.key',
      headers: { cookie: cookies.admin }, payload: { value: 'x' }
    });
    assert.equal(nf.statusCode, 404);
  } finally { await cleanup(app, dbPath); }
});
