// auth.test.js — DR-T03 验收测试
// 核心验收:错密 5 次锁定 + 登录后 me 返回员工+权限
// 不起真端口,用 Fastify inject 模拟 HTTP。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initDb } = require('./db');
const { seedAccount, MAX_FAILED } = require('./auth');

// ---- 通用 fixture ----
function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  return path.join(dir, 'test.db');
}

// 清理:app.close() 已通过 onClose 关 db;Windows 上 WAL 文件可能仍短暂锁定,带重试删
async function cleanup(app, dbPath) {
  try { await app.close(); } catch {}
  const dir = path.dirname(dbPath);
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      await new Promise(r => setTimeout(r, 100 * (i + 1)));
    }
  }
  // 最后兜底:尽力删文件,不阻塞测试
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function buildTestApp() {
  const p = tmpDbPath();
  const { buildApp } = require('./app');
  const app = await buildApp({ dbPath: p, cookieSecret: 'test-secret-for-dr-t03' });
  await app.ready();

  // 种 3 个测试账号
  await seedAccount(app.db, {
    employee_id: 1001,
    account: 'EMP1001',
    password: 'TestPwd@2024',
    name: '库管员-张',
    position: '仓库管理员',
    department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self', modules: { inventory: ['view','edit'] }, admin_level: 0 }
  });
  await seedAccount(app.db, {
    employee_id: 1002,
    account: 'EMP1002',
    password: 'EmpPwd@2024',
    name: '一线-李',
    position: '保洁员',
    department: '一线作业',
    permissions: null   // 无权限记录 → me 返回 permissions: null
  });

  return { app, dbPath: p };
}

test('DR-T03-01: 正确密码登录成功,Set-Cookie HttpOnly,me 返回员工+权限', async () => {
  const { app, dbPath } = await buildTestApp();
  try {
    // 登录
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1001', password: 'TestPwd@2024' }
    });
    assert.equal(loginRes.statusCode, 200, '登录应成功');
    const loginBody = loginRes.json();
    assert.equal(loginBody.ok, true);
    assert.equal(loginBody.employee_id, 1001);
    assert.equal(loginBody.must_change_pwd, false);

    // 校验 Set-Cookie
    const setCookie = loginRes.headers['set-cookie'] || '';
    assert.match(setCookie, /sid=/, '应设置 sid cookie');
    assert.match(setCookie, /HttpOnly/i, '应 HttpOnly');
    assert.match(setCookie, /SameSite=Strict/i, '应 SameSite=Strict');

    // 提取 token,用于 me
    const token = setCookie.match(/sid=([^;]+)/)[1];

    // me
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `sid=${token}` }
    });
    assert.equal(meRes.statusCode, 200);
    const meBody = meRes.json();
    assert.equal(meBody.ok, true);
    assert.equal(meBody.employee.employee_id, 1001);
    assert.equal(meBody.employee.name, '库管员-张');
    assert.equal(meBody.employee.account, 'EMP1001');
    assert.equal(meBody.employee.department, '仓储部');
    // permissions 合成
    assert.equal(meBody.permissions.level, 3);
    assert.equal(meBody.permissions.scope, 'self');
    assert.deepEqual(meBody.permissions.modules, { inventory: ['view','edit'] });
    assert.equal(meBody.permissions.admin_level, 0);
  } finally {
    await cleanup(app, dbPath);
  }
});

test('DR-T03-02: 错密 5 次自动锁定(423),登录成功后计数归零', async () => {
  const { app, dbPath } = await buildTestApp();
  try {
    // 错 4 次:每次 401 + 递减的 remaining_attempts
    for (let i = 1; i <= 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { account: 'EMP1001', password: 'WrongPassword!' }
      });
      assert.equal(res.statusCode, 401, `第 ${i} 次错密应 401`);
      const body = res.json();
      assert.equal(body.ok, false);
      assert.equal(body.remaining_attempts, MAX_FAILED - i, `第 ${i} 次后应剩 ${MAX_FAILED - i}`);
    }

    // 第 5 次:触发锁定,返回 423
    const res5 = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1001', password: 'WrongPassword!' }
    });
    assert.equal(res5.statusCode, 423, '第 5 次错密应锁定(423)');
    assert.match(res5.json().error, /锁定/);

    // 即使用正确密码也进不去(锁定了)
    const res6 = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1001', password: 'TestPwd@2024' }
    });
    assert.equal(res6.statusCode, 423, '锁定后正确密码也 423');

    // 验证 employees 表 locked_at 已写、account_lock_log 有 lock 事件
    const db = app.db;
    const emp = db.prepare('SELECT failed_attempts, locked_at FROM employees WHERE employee_id = 1001').get();
    assert.equal(emp.failed_attempts, MAX_FAILED);
    assert.ok(emp.locked_at, 'locked_at 应已写');
    const lockLog = db.prepare("SELECT * FROM account_lock_log WHERE employee_id = 1001 AND event = 'lock'").get();
    assert.ok(lockLog, 'account_lock_log 应有 lock 事件');
  } finally {
    await cleanup(app, dbPath);
  }
});

test('DR-T03-03: 登录成功后错误计数归零,下次再错 5 次才锁', async () => {
  const { app, dbPath } = await buildTestApp();
  try {
    // 错 3 次
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/auth/login', payload: { account: 'EMP1001', password: 'Wrong!' } });
    }
    // 正确登录一次 → 计数归零
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1001', password: 'TestPwd@2024' }
    });
    assert.equal(loginRes.statusCode, 200);

    const db = app.db;
    const emp = db.prepare('SELECT failed_attempts, locked_at FROM employees WHERE employee_id = 1001').get();
    assert.equal(emp.failed_attempts, 0, '登录成功后计数应归零');
    assert.equal(emp.locked_at, null, 'locked_at 应清空');

    // 再次错 5 次才锁
    for (let i = 1; i <= MAX_FAILED; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { account: 'EMP1001', password: 'Wrong!' }
      });
      if (i < MAX_FAILED) assert.equal(res.statusCode, 401);
      else assert.equal(res.statusCode, 423);
    }
  } finally {
    await cleanup(app, dbPath);
  }
});

test('DR-T03-04: 未登录 me 返回 401;logout 后旧 token 失效', async () => {
  const { app, dbPath } = await buildTestApp();
  try {
    // 未登录 me
    const resNoAuth = await app.inject({ method: 'GET', url: '/auth/me' });
    assert.equal(resNoAuth.statusCode, 401);

    // 登录
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1002', password: 'EmpPwd@2024' }
    });
    const token = loginRes.headers['set-cookie'].match(/sid=([^;]+)/)[1];

    // me 有效
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `sid=${token}` }
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().employee.employee_id, 1002);
    // 无 permissions 记录 → null
    assert.equal(meRes.json().permissions, null);

    // logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `sid=${token}` }
    });
    assert.equal(logoutRes.statusCode, 200);

    // 旧 token 已失效
    const meAfter = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `sid=${token}` }
    });
    assert.equal(meAfter.statusCode, 401);
  } finally {
    await cleanup(app, dbPath);
  }
});

test('DR-T03-05: change-password 首登强制改密流程', async () => {
  const { app, dbPath } = await buildTestApp();
  try {
    // 种一个 must_change_pwd=1 的账号
    const db = app.db;
    db.prepare('UPDATE employees SET must_change_pwd = 1 WHERE employee_id = 1001').run();

    // 登录 → 应返回 must_change_pwd=true
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1001', password: 'TestPwd@2024' }
    });
    assert.equal(loginRes.json().must_change_pwd, true);

    const token = loginRes.headers['set-cookie'].match(/sid=([^;]+)/)[1];

    // 改密:新密码 = 默认密码 → 拒绝
    const resDefault = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { cookie: `sid=${token}` },
      payload: { old_password: 'TestPwd@2024', new_password: 'Aa@123456' }
    });
    assert.equal(resDefault.statusCode, 400, '新密码 = 默认密码应拒绝');

    // 改密:新密码太短 → 拒绝
    const resShort = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { cookie: `sid=${token}` },
      payload: { old_password: 'TestPwd@2024', new_password: 'short' }
    });
    assert.equal(resShort.statusCode, 400, '新密码 < 8 位应拒绝');

    // 改密成功
    const resOk = await app.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { cookie: `sid=${token}` },
      payload: { old_password: 'TestPwd@2024', new_password: 'NewStrongPwd@2024!' }
    });
    assert.equal(resOk.statusCode, 200);
    assert.equal(resOk.json().ok, true);

    // must_change_pwd 已清零
    const emp = db.prepare('SELECT must_change_pwd FROM employees WHERE employee_id = 1001').get();
    assert.equal(emp.must_change_pwd, 0);

    // 用新密码能登
    const reLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { account: 'EMP1001', password: 'NewStrongPwd@2024!' }
    });
    assert.equal(reLogin.statusCode, 200);
    assert.equal(reLogin.json().must_change_pwd, false, '改密后 must_change_pwd 应为 false');
  } finally {
    await cleanup(app, dbPath);
  }
});
