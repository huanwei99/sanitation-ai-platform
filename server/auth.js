// auth.js — DR-T03 认证:login/logout/me/change-password
// 遵循 PHASE0 §7 + SOP-Org-03:bcrypt 密码、HttpOnly 会话 cookie、错密 5 次锁定。
// 服务端强制;me 仅用于前端 UI 门控,权限判定每次请求由服务端重查。

const crypto = require('node:crypto');
const { getPragmaNumber } = require('./db');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_S = 12 * 3600;        // 12 小时会话
const MAX_FAILED = 5;                    // SOP-Org-03:连续错 5 次锁定
const PWD_ALGO = 'bcryptjs';             // 纯 JS,零原生编译

// ---------- 密码哈希 ----------
async function hashPassword(plain) {
  const bcrypt = require('bcryptjs');
  return bcrypt.hash(plain, 10);
}
async function verifyPassword(plain, hash) {
  if (!hash) return false;
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(plain, hash);
}

// ---------- 会话 ----------
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
// 创建会话并写入 sessions 表,返回 token
function createSession(db, employeeId, ttlS = SESSION_TTL_S) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlS * 1000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, employee_id, expires_at) VALUES (?,?,?)'
  ).run(token, employeeId, expiresAt);
  return { token, expiresAt };
}
// 取会话对应的有效员工(过期/无效返回 null)
function resolveSession(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, e.employee_id, e.account, e.name,
            e.position, e.department, e.is_active, e.must_change_pwd,
            e.failed_attempts, e.locked_at
       FROM sessions s
       JOIN employees e ON e.employee_id = s.employee_id
      WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) return null;   // 过期
  if (!row.is_active) return null;                            // 停用
  return row;
}

// 权限三要素(employee + permissions 表合成)
function effectivePermissions(db, employeeId) {
  const p = db.prepare(
    'SELECT mode, level, scope, modules, admin_level FROM permissions WHERE employee_id = ?'
  ).get(employeeId);
  if (!p) return null;
  let modules;
  try { modules = JSON.parse(p.modules || '{}'); } catch { modules = {}; }
  return {
    mode: p.mode,
    level: p.level,
    scope: p.scope,
    admin_level: p.admin_level,
    modules
  };
}

// ---------- 权限判定(P0-T01 三要素:模块/操作/范围) ----------

/**
 * 判定主体是否有权对 target 执行 module.action。
 * - admin_level >= 3(总部)放行全部
 * - 模块操作须在 perm.modules 中(支持 'ALL' 通配)
 * - 数据范围由 isWithinScope 校验(self/team/dept/project/region/group)
 * @param {object} db        数据库
 * @param {object} principal req.principal(含 employee_id)
 * @param {string} module    模块名,如 'distribution'
 * @param {string} action    操作名,如 'edit'
 * @param {number|null} targetEmployeeId 被操作目标工号;null 表示不做范围校验
 */
function hasPermission(db, principal, module, action, targetEmployeeId = null) {
  const perm = effectivePermissions(db, principal.employee_id);
  if (!perm) return false;
  if (perm.admin_level >= 3) return true;  // 总部管理员放行

  const mod = perm.modules[module];
  if (!mod) return false;
  const actionOk = mod === 'ALL' || (Array.isArray(mod) && (mod.includes('ALL') || mod.includes(action)));
  if (!actionOk) return false;

  // 无目标或目标即本人 → 范围天然满足
  if (targetEmployeeId == null || targetEmployeeId === principal.employee_id) return true;
  return isWithinScope(db, perm, principal.employee_id, targetEmployeeId);
}

/**
 * 数据范围校验:self/team/dept/project/region/group
 */
function isWithinScope(db, perm, principalId, targetId) {
  if (perm.scope === 'group') return true;
  if (perm.scope === 'self') return targetId === principalId;
  const me = db.prepare(
    'SELECT department, team_id, project_id, region_id FROM employees WHERE employee_id = ?'
  ).get(principalId);
  const tgt = db.prepare(
    'SELECT department, team_id, project_id, region_id FROM employees WHERE employee_id = ?'
  ).get(targetId);
  if (!me || !tgt) return false;
  switch (perm.scope) {
    case 'team':    return me.team_id != null && me.team_id === tgt.team_id;
    case 'dept':    return !!me.department && me.department === tgt.department;
    case 'project': return me.project_id != null && me.project_id === tgt.project_id;
    case 'region':  return me.region_id != null && me.region_id === tgt.region_id;
    default:        return false;
  }
}

/**
 * 层级授权判定(P0-T01):只能向下授权,不能向上修改;同级互不干涉。
 * - granter.admin_level 必须 > target 当前 admin_level(不能改上级/同级)
 * - 授予的 newAdminLevel 必须 < granter.admin_level(不能任命同级或上级)
 */
function canModifyPermissions(granterPerm, targetCurrentAdminLevel, newAdminLevel) {
  if (!granterPerm || granterPerm.admin_level <= 0) return false;
  if (targetCurrentAdminLevel >= granterPerm.admin_level) return false;
  if (newAdminLevel >= granterPerm.admin_level) return false;
  return true;
}

/**
 * Fastify preValidation 钩子工厂:requirePermission(module, action)
 * 从 req.principal 取主体,目标工号从 req.params.employee_id 或 req.body.target_id 取。
 */
function requirePermission(module, action) {
  return async (req, reply) => {
    const principal = req.principal;
    if (!principal) return reply.code(401).send({ ok: false, error: '未登录' });
    const targetId = req.params?.employee_id
      ? Number(req.params.employee_id)
      : (req.body?.target_id ? Number(req.body.target_id) : null);
    if (!hasPermission(req.app.db, principal, module, action, targetId)) {
      return reply.code(403).send({ ok: false, error: `无权限:${module}.${action}` });
    }
  };
}

// ---------- 锁定逻辑 ----------
function isLocked(row) {
  return !!row.locked_at;   // 锁定后需管理员解锁才清 locked_at
}

// 登录成功/失败时维护计数
function resetFailed(db, employeeId) {
  db.prepare(
    'UPDATE employees SET failed_attempts = 0, locked_at = NULL WHERE employee_id = ?'
  ).run(employeeId);
}
function recordFailed(db, employeeId) {
  db.prepare(
    'UPDATE employees SET failed_attempts = failed_attempts + 1 WHERE employee_id = ?'
  ).run(employeeId);
  const row = db.prepare(
    'SELECT failed_attempts FROM employees WHERE employee_id = ?'
  ).get(employeeId);
  if (row.failed_attempts >= MAX_FAILED) {
    // 达阈值即锁定:写 locked_at + 审计
    db.prepare(
      'UPDATE employees SET locked_at = CURRENT_TIMESTAMP WHERE employee_id = ?'
    ).run(employeeId);
    db.prepare(
      "INSERT INTO account_lock_log (employee_id, event, actor_id, reason) VALUES (?, 'lock', NULL, ?)"
    ).run(employeeId, `连续 ${MAX_FAILED} 次错密自动锁定`);
  }
}

// ---------- 路由注册 ----------
async function registerAuthRoutes(app, opts = {}) {
  if (!app.db) {
    app.log.warn('[auth] db 不可用,跳过 auth 路由注册');
    return;
  }

  // cookie 解析(HttpOnly 会话)
  try {
    const cookie = require('@fastify/cookie');
    await app.register(cookie, { secret: opts.cookieSecret || undefined });
  } catch (e) {
    app.log.error(e, '[auth] @fastify/cookie 未安装,无法用会话 cookie');
    throw e;
  }

  // ---- POST /auth/login { account, password } ----
  app.post('/auth/login', async (req, reply) => {
    const { account, password } = req.body || {};
    if (!account || !password) {
      return reply.code(400).send({ ok: false, error: '需要 account 与 password' });
    }
    const emp = app.db.prepare(
      'SELECT employee_id, account, password_hash, is_active, failed_attempts, locked_at FROM employees WHERE account = ?'
    ).get(account);
    if (!emp) {
      // 账号不存在:不泄露存在性
      return reply.code(401).send({ ok: false, error: '账号或密码错误' });
    }
    if (!emp.is_active) {
      return reply.code(403).send({ ok: false, error: '账号已停用,联系管理员' });
    }
    if (isLocked(emp)) {
      return reply.code(423).send({
        ok: false,
        error: `账号已锁定(连续 ${MAX_FAILED} 次错密),请联系管理员解锁`
      });
    }
    const ok = await verifyPassword(password, emp.password_hash);
    if (!ok) {
      recordFailed(app.db, emp.employee_id);
      // 重新查一下,给出剩余次数提示(锁定前)
      const after = app.db.prepare(
        'SELECT failed_attempts, locked_at FROM employees WHERE employee_id = ?'
      ).get(emp.employee_id);
      if (after.locked_at) {
        return reply.code(423).send({ ok: false, error: `账号已锁定(连续 ${MAX_FAILED} 次错密),请联系管理员解锁` });
      }
      const remaining = Math.max(0, MAX_FAILED - after.failed_attempts);
      return reply.code(401).send({ ok: false, error: '账号或密码错误', remaining_attempts: remaining });
    }

    // 密码正确 → 重置计数、建会话
    resetFailed(app.db, emp.employee_id);
    const fresh = app.db.prepare('SELECT must_change_pwd FROM employees WHERE employee_id = ?').get(emp.employee_id);
    const { token, expiresAt } = createSession(app.db, emp.employee_id);

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,             // LAN 试点纯 HTTP;上公网需 TLS + secure:true
      path: '/',
      maxAge: SESSION_TTL_S
    });
    return reply.send({
      ok: true,
      employee_id: emp.employee_id,
      account: emp.account,
      must_change_pwd: !!fresh.must_change_pwd,
      expires_at: expiresAt
    });
  });

  // ---- POST /auth/logout ----
  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    if (token) {
      app.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  // ---- GET /auth/me ----
  app.get('/auth/me', async (req, reply) => {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    const sess = resolveSession(app.db, token);
    if (!sess) {
      return reply.code(401).send({ ok: false, error: '未登录或会话过期' });
    }
    const perms = effectivePermissions(app.db, sess.employee_id);
    return reply.send({
      ok: true,
      employee: {
        employee_id: sess.employee_id,
        account: sess.account,
        name: sess.name,
        position: sess.position,
        department: sess.department,
        must_change_pwd: !!sess.must_change_pwd
      },
      permissions: perms
    });
  });

  // ---- POST /auth/change-password { old_password, new_password } ----
  app.post('/auth/change-password', async (req, reply) => {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    const sess = resolveSession(app.db, token);
    if (!sess) {
      return reply.code(401).send({ ok: false, error: '未登录或会话过期' });
    }
    const { old_password, new_password } = req.body || {};
    if (!old_password || !new_password) {
      return reply.code(400).send({ ok: false, error: '需要 old_password 与 new_password' });
    }
    // 基线策略:新密码与默认密码不同、长度 ≥ 8(SOP-Org-03 默认 Aa@123456)
    if (new_password.length < 8) {
      return reply.code(400).send({ ok: false, error: '新密码至少 8 位' });
    }
    if (new_password === 'Aa@123456') {
      return reply.code(400).send({ ok: false, error: '新密码不能与默认密码相同' });
    }
    // C-2①: 禁止新旧密码相同(原密码已验证即当前密码,明文比较即可)
    if (new_password === old_password) {
      return reply.code(400).send({ ok: false, error: '新密码不能与原密码相同' });
    }
    const emp = app.db.prepare(
      'SELECT password_hash FROM employees WHERE employee_id = ?'
    ).get(sess.employee_id);
    const ok = await verifyPassword(old_password, emp.password_hash);
    if (!ok) {
      return reply.code(401).send({ ok: false, error: '原密码错误' });
    }
    const newHash = await hashPassword(new_password);
    app.db.prepare(
      'UPDATE employees SET password_hash = ?, must_change_pwd = 0 WHERE employee_id = ?'
    ).run(newHash, sess.employee_id);
    // 改密后失效其他会话(保留当前),强制其他设备重登
    app.db.prepare(
      'DELETE FROM sessions WHERE employee_id = ? AND token <> ?'
    ).run(sess.employee_id, token);
    return reply.send({ ok: true });
  });

  // 装饰器:供后续受保护路由做 AuthN 前置(可选调用)
  app.decorate('authenticate', async (req, reply) => {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    const sess = resolveSession(app.db, token);
    if (!sess) {
      reply.code(401).send({ ok: false, error: '未登录或会话过期' });
      return null;
    }
    req.principal = {
      employee_id: sess.employee_id,
      account: sess.account,
      name: sess.name,
      position: sess.position,
      department: sess.department
    };
    return req.principal;
  });

  // ---- POST /auth/unlock(管理员解锁被锁账号,C-2②) ----
  // 必须在 app.decorate('authenticate') 之后注册,否则 preValidation 引用未定义
  // 权限:admin_level >= 1(与 canApprove/canViewAudit 同口径)
  // 不进 chain_event(账号管理,非发放链)
  app.post('/auth/unlock', { preValidation: [app.authenticate] }, async (req, reply) => {
    const body = req.body || {};
    const targetId = Number(body.employee_id);
    if (!targetId || !Number.isInteger(targetId)) {
      return reply.code(400).send({ ok: false, error: '需要 employee_id' });
    }
    const reason = body.reason || null;    // 可选(拍板结论:默认可选)

    // 权限:请求者 admin_level >= 1
    const p = app.db.prepare(
      'SELECT admin_level FROM permissions WHERE employee_id = ?'
    ).get(req.principal.employee_id);
    if (!p || p.admin_level < 1) {
      return reply.code(403).send({ ok: false, error: '需要管理员权限(admin_level>=1)' });
    }

    // 目标必须已锁定
    const target = app.db.prepare(
      'SELECT employee_id, locked_at FROM employees WHERE employee_id = ?'
    ).get(targetId);
    if (!target) return reply.code(404).send({ ok: false, error: '目标账号不存在' });
    if (!target.locked_at) {
      return reply.code(409).send({ ok: false, error: '账号未锁定,无需解锁' });
    }

    // 解锁:清零失败计数 + 置 locked_at=NULL
    app.db.prepare(
      'UPDATE employees SET failed_attempts = 0, locked_at = NULL WHERE employee_id = ?'
    ).run(targetId);

    // 审计日志(event 枚举预留 unlock;列名 actor_id)
    const operatorId = req.principal.employee_id;
    app.db.prepare(
      `INSERT INTO account_lock_log (employee_id, event, actor_id, reason)
       VALUES (?, 'unlock', ?, ?)`
    ).run(targetId, operatorId, reason);

    return reply.send({ ok: true, employee_id: targetId, unlocked_by: operatorId });
  });

  // ---- PUT /auth/permissions/:employee_id (层级授权,P0-T01) ----
  // 只能向下授权:granter.admin_level 必须严格大于 target 当前级别与新级别。
  app.put('/auth/permissions/:employee_id', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    const targetId = Number(req.params.employee_id);
    const { mode, level, scope, modules, admin_level } = req.body || {};
    const newAdminLevel = Number(admin_level) || 0;

    const granterPerm = effectivePermissions(app.db, req.principal.employee_id);
    const targetRow = app.db.prepare(
      'SELECT admin_level FROM permissions WHERE employee_id = ?'
    ).get(targetId);
    const targetCurrentAdminLevel = targetRow ? targetRow.admin_level : 0;

    if (!canModifyPermissions(granterPerm, targetCurrentAdminLevel, newAdminLevel)) {
      return reply.code(403).send({
        ok: false, error: '无权修改该账号权限(只能向下授权,不能改上级/同级)'
      });
    }

    const mods = JSON.stringify(modules || {});
    app.db.prepare(
      `INSERT INTO permissions (employee_id, mode, level, scope, modules, admin_level, granted_by)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(employee_id) DO UPDATE SET
         mode=excluded.mode, level=excluded.level, scope=excluded.scope,
         modules=excluded.modules, admin_level=excluded.admin_level, granted_by=excluded.granted_by`
    ).run(targetId, mode || 'manual', Number(level) || 3, scope || 'self', mods, newAdminLevel, req.principal.employee_id);

    return reply.send({ ok: true, employee_id: targetId, granted_by: req.principal.employee_id, admin_level: newAdminLevel });
  });
}

// 便捷函数:种测试/初始账号(哈希后写入 employees + permissions)
async function seedAccount(db, { employee_id, account, password, name = '测试', position = null, department = null, permissions = null }) {
  const hash = await hashPassword(password);
  db.prepare(
    `INSERT INTO employees (employee_id, name, account, password_hash, position, department, is_active, must_change_pwd)
     VALUES (?,?,?,?,?,?,1,0)
     ON CONFLICT(employee_id) DO UPDATE SET account=excluded.account, password_hash=excluded.password_hash`
  ).run(employee_id, name, account, hash, position, department);
  if (permissions) {
    const mods = JSON.stringify(permissions.modules || {});
    db.prepare(
      `INSERT INTO permissions (employee_id, mode, level, scope, modules, admin_level)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(employee_id) DO UPDATE SET mode=excluded.mode, level=excluded.level,
         scope=excluded.scope, modules=excluded.modules, admin_level=excluded.admin_level`
    ).run(employee_id, permissions.mode || 'manual', permissions.level || 3,
          permissions.scope || 'self', mods, permissions.admin_level || 0);
  }
  return employee_id;
}

module.exports = {
  registerAuthRoutes, hashPassword, verifyPassword, createSession, resolveSession,
  effectivePermissions, isLocked, recordFailed, resetFailed, seedAccount,
  hasPermission, isWithinScope, canModifyPermissions, requirePermission,
  SESSION_COOKIE, MAX_FAILED, PWD_ALGO
};