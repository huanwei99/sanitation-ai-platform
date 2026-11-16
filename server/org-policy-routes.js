// org-policy-routes.js — P0-T02 org_policy 管理 API
// GET  /org-policy       列出全部策略(admin_level>=1 或 level>=3)
// PUT  /org-policy/:key  修改策略值(同上权限),即时生效

const { listPolicies, setPolicy, getPolicy } = require('./org-policy');

function canManagePolicy(db, employeeId) {
  const p = db.prepare('SELECT level, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  return p.admin_level >= 1 || p.level >= 3;
}

async function registerOrgPolicyRoutes(app) {
  // ---- 列出全部策略 ----
  app.get('/org-policy', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    if (!canManagePolicy(app.db, req.principal.employee_id)) {
      return reply.code(403).send({ ok: false, error: '无策略管理权限(需 admin_level>=1 或 level>=3)' });
    }
    const policies = listPolicies(app.db);
    return reply.send({ ok: true, policies });
  });

  // ---- 修改单个策略 ----
  app.put('/org-policy/:key', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    if (!canManagePolicy(app.db, req.principal.employee_id)) {
      return reply.code(403).send({ ok: false, error: '无策略管理权限(需 admin_level>=1 或 level>=3)' });
    }
    const { key } = req.params;
    const { value } = req.body || {};
    if (value === undefined || value === null) {
      return reply.code(400).send({ ok: false, error: '需要 value 字段' });
    }
    // 仅允许修改已知策略键(防止任意注入)
    const known = listPolicies(app.db).map(p => p.key);
    if (!known.includes(key)) {
      return reply.code(404).send({ ok: false, error: `策略键 ${key} 不存在` });
    }
    const result = setPolicy(app.db, key, value);
    return reply.send({ ok: true, ...result, now: getPolicy(app.db, key) });
  });
}

module.exports = { registerOrgPolicyRoutes, canManagePolicy };
