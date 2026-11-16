// rbac.test.js — P0-T01 RBAC 完整:三要素判定 + 层级授权
// 验收:hasPermission 全用例过;越权修改上级权限被拒;只能向下授权。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('./app');
const { seedAccount, hasPermission, isWithinScope, canModifyPermissions, effectivePermissions } = require('./auth');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-test-'));
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

// 种一批同部门/同项目的账号,便于范围校验
async function buildFixture() {
  const dbPath = tmpDbPath();
  const app = await buildApp({ dbPath, cookieSecret: 'rbac-secret' });
  await app.ready();

  // 总部管理员(admin_level=3)
  await seedAccount(app.db, {
    employee_id: 7001, account: 'EMP7001', password: 'Pwd7001@x', name: 'HQ-Admin',
    position: '总部管理员', department: '总部',
    permissions: { mode: 'manual', level: 5, scope: 'group', modules: {}, admin_level: 3 }
  });
  // 区域管理员(admin_level=2)
  await seedAccount(app.db, {
    employee_id: 7002, account: 'EMP7002', password: 'Pwd7002@x', name: 'Region-Admin',
    position: '区域经理', department: '华东区',
    permissions: { mode: 'manual', level: 4, scope: 'region', modules: {}, admin_level: 2 }
  });
  // 项目管理员(admin_level=1)
  await seedAccount(app.db, {
    employee_id: 7003, account: 'EMP7003', password: 'Pwd7003@x', name: 'Project-Admin',
    position: '项目经理', department: '项目A',
    permissions: { mode: 'manual', level: 3, scope: 'project', modules: {}, admin_level: 1 }
  });
  // 库管员(有 distribution.edit, scope=dept)
  await seedAccount(app.db, {
    employee_id: 7004, account: 'EMP7004', password: 'Pwd7004@x', name: 'Keeper',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'dept',
      modules: { distribution: ['edit'] }, admin_level: 0 }
  });
  // 一线(仅 self,无 distribution 模块)
  await seedAccount(app.db, {
    employee_id: 7005, account: 'EMP7005', password: 'Pwd7005@x', name: 'Worker',
    position: '保洁员', department: '一线作业',
    permissions: { mode: 'manual', level: 1, scope: 'self', modules: {}, admin_level: 0 }
  });
  // 同部门另一名库管员(用于 dept 范围校验)
  await seedAccount(app.db, {
    employee_id: 7006, account: 'EMP7006', password: 'Pwd7006@x', name: 'Keeper2',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'dept',
      modules: { distribution: ['view'] }, admin_level: 0 }
  });

  async function login(account, password) {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { account, password } });
    assert.equal(r.statusCode, 200, `登录失败 ${account}: ${r.body}`);
    return `sid=${r.headers['set-cookie'].match(/sid=([^;]+)/)[1]}`;
  }
  const cookies = {
    hq: await login('EMP7001', 'Pwd7001@x'),
    region: await login('EMP7002', 'Pwd7002@x'),
    project: await login('EMP7003', 'Pwd7003@x'),
    keeper: await login('EMP7004', 'Pwd7004@x'),
    worker: await login('EMP7005', 'Pwd7005@x'),
    keeper2: await login('EMP7006', 'Pwd7006@x'),
  };
  return { app, dbPath, cookies };
}

// ---- hasPermission 单元测试 ----
test('RBAC-01: admin_level>=3 放行全部', async () => {
  const { app, dbPath } = await buildFixture();
  try {
    const principal = { employee_id: 7001 };
    assert.equal(hasPermission(app.db, principal, 'distribution', 'edit', 9999), true);
    assert.equal(hasPermission(app.db, principal, 'anymodule', 'anyaction', null), true);
  } finally { await cleanup(app, dbPath); }
});

test('RBAC-02: 模块/操作匹配 + ALL 通配', async () => {
  const { app, dbPath } = await buildFixture();
  try {
    const keeper = { employee_id: 7004 };
    // 有 distribution.edit
    assert.equal(hasPermission(app.db, keeper, 'distribution', 'edit', 7004), true);
    // 无 distribution.view
    assert.equal(hasPermission(app.db, keeper, 'distribution', 'view', 7004), false);
    // 无 inventory 模块
    assert.equal(hasPermission(app.db, keeper, 'inventory', 'edit', 7004), false);
  } finally { await cleanup(app, dbPath); }
});

test('RBAC-03: 范围校验 self/dept/group', async () => {
  const { app, dbPath } = await buildFixture();
  try {
    const keeper = { employee_id: 7004 };  // scope=dept, department=仓储部
    // 本人 → true
    assert.equal(hasPermission(app.db, keeper, 'distribution', 'edit', 7004), true);
    // 同部门 7006 → true(dept)
    assert.equal(hasPermission(app.db, keeper, 'distribution', 'edit', 7006), true);
    // 跨部门 7005(一线作业) → false
    assert.equal(hasPermission(app.db, keeper, 'distribution', 'edit', 7005), false);

    const worker = { employee_id: 7005 };  // scope=self
    assert.equal(hasPermission(app.db, worker, 'distribution', 'edit', 7005), false); // 无模块
  } finally { await cleanup(app, dbPath); }
});

test('RBAC-04: canModifyPermissions 层级规则', async () => {
  // 总部(3)可改区域(2)的权限,新级别<=2
  assert.equal(canModifyPermissions({ admin_level: 3 }, 2, 2), true);
  assert.equal(canModifyPermissions({ admin_level: 3 }, 2, 1), true);
  // 总部不能任命同级(3)
  assert.equal(canModifyPermissions({ admin_level: 3 }, 2, 3), false);
  // 区域(2)不能改总部(3)
  assert.equal(canModifyPermissions({ admin_level: 2 }, 3, 0), false);
  // 区域(2)可改项目(1),新级别<=1
  assert.equal(canModifyPermissions({ admin_level: 2 }, 1, 1), true);
  // 区域不能任命同级(2)
  assert.equal(canModifyPermissions({ admin_level: 2 }, 1, 2), false);
  // 项目(1)不能改同级(1)
  assert.equal(canModifyPermissions({ admin_level: 1 }, 1, 0), false);
  // 非管理员(0)不能改任何人
  assert.equal(canModifyPermissions({ admin_level: 0 }, 0, 0), false);
});

// ---- PUT /auth/permissions/:employee_id 接口测试 ----
test('RBAC-05: 总部向下授权成功;区域改上级被拒', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    // 总部(7001,admin=3) 把 7005(worker,admin=0) 提到 admin=1
    const grant = await app.inject({
      method: 'PUT', url: '/auth/permissions/7005',
      headers: { cookie: cookies.hq },
      payload: { mode: 'manual', level: 3, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
    });
    assert.equal(grant.statusCode, 200, `总部授权应 200: ${grant.body}`);
    assert.equal(grant.json().admin_level, 1);
    assert.equal(grant.json().granted_by, 7001);

    // 区域(7002,admin=2) 试图改 7001(总部,admin=3) → 403
    const up = await app.inject({
      method: 'PUT', url: '/auth/permissions/7001',
      headers: { cookie: cookies.region },
      payload: { mode: 'manual', level: 1, scope: 'self', modules: {}, admin_level: 0 }
    });
    assert.equal(up.statusCode, 403, '区域改上级应 403');

    // 区域(7002) 试图把 7005 任命为 admin=2(同级) → 403
    const same = await app.inject({
      method: 'PUT', url: '/auth/permissions/7005',
      headers: { cookie: cookies.region },
      payload: { mode: 'manual', level: 3, scope: 'region', modules: {}, admin_level: 2 }
    });
    assert.equal(same.statusCode, 403, '任命同级应 403');

    // 区域(7002) 正常把 7005 设为 admin=1 → 200
    const ok = await app.inject({
      method: 'PUT', url: '/auth/permissions/7005',
      headers: { cookie: cookies.region },
      payload: { mode: 'manual', level: 3, scope: 'project', modules: { distribution: ['edit'] }, admin_level: 1 }
    });
    assert.equal(ok.statusCode, 200, `区域向下授权应 200: ${ok.body}`);
  } finally { await cleanup(app, dbPath); }
});

test('RBAC-06: 非管理员无权授权', async () => {
  const { app, dbPath, cookies } = await buildFixture();
  try {
    const r = await app.inject({
      method: 'PUT', url: '/auth/permissions/7005',
      headers: { cookie: cookies.keeper },
      payload: { mode: 'manual', level: 1, scope: 'self', modules: {}, admin_level: 0 }
    });
    assert.equal(r.statusCode, 403, '非管理员授权应 403');
  } finally { await cleanup(app, dbPath); }
});
