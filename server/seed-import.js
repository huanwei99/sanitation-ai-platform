// seed-import.js — P0-T07 物料/员工/仓库批量导入(幂等)
//
// GET  /seed/template?type=items|employees|depots   下载导入模板(JSON 示例)
// POST /seed/import                                   批量导入(幂等 UPSERT,逐行结果)
//
// 幂等键: items → (id,depot_id); employees → employee_id; depots → id。
// 权限: admin_level >= 1 或 level >= 3。

const bcrypt = require('bcryptjs');

const TYPES = ['items', 'employees', 'depots'];

// 模板:返回一个示例行 + 字段说明
const TEMPLATES = {
  items: {
    sample: { id: 'INV-100', name: '示例物资', category: 'consumable', unit: '个', stock: 100, min_stock: 10, unit_cost: 500, depot_id: 'DP-001' },
    fields: {
      id: '物资编号(必填,同 depot_id 唯一)',
      name: '名称(必填)',
      category: '类别: consumable/tool/spare/office',
      unit: '单位(必填)',
      stock: '库存数量(必填,>=0)',
      min_stock: '安全库存(必填,>=0)',
      unit_cost: '单价(分,必填,>=0)',
      depot_id: '仓库编号(必填,如 DP-001)',
    }
  },
  employees: {
    sample: { employee_id: 2001, name: '张三', position: '保洁员', department: '一线', account: 'EMP2001', password: '初始密码(可选)' },
    fields: {
      employee_id: '工号(必填,主键)',
      name: '姓名(必填)',
      position: '岗位',
      department: '部门',
      account: '登录账号(必填,唯一)',
      password: '初始密码(可选;不填则不设置密码,无法登录)',
    }
  },
  depots: {
    sample: { id: 'DP-003', name: '片区三仓', is_active: 1 },
    fields: {
      id: '仓库编号(必填,主键,如 DP-003)',
      name: '仓库名称(必填)',
      is_active: '是否启用:1/0(默认 1)',
    }
  }
};

function canImport(db, employeeId) {
  const p = db.prepare('SELECT level, admin_level FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  return p.admin_level >= 1 || p.level >= 3;
}

async function registerSeedImportRoutes(app) {
  // ---- GET /seed/template ----
  app.get('/seed/template', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    if (!canImport(app.db, req.principal.employee_id)) {
      return reply.code(403).send({ ok: false, error: '无导入权限(需 admin_level>=1 或 level>=3)' });
    }
    const type = req.query?.type;
    if (!TYPES.includes(type)) {
      return reply.code(400).send({ ok: false, error: `type 须为 ${TYPES.join('|')}` });
    }
    return reply.send({ ok: true, type, ...TEMPLATES[type] });
  });

  // ---- POST /seed/import ----
  app.post('/seed/import', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    if (!canImport(app.db, req.principal.employee_id)) {
      return reply.code(403).send({ ok: false, error: '无导入权限(需 admin_level>=1 或 level>=3)' });
    }
    const { type, data } = req.body || {};
    if (!TYPES.includes(type)) {
      return reply.code(400).send({ ok: false, error: `type 须为 ${TYPES.join('|')}` });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return reply.code(400).send({ ok: false, error: 'data 须为非空数组' });
    }
    if (data.length > 500) {
      return reply.code(400).send({ ok: false, error: '单次导入最多 500 条' });
    }

    const results = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        let msg;
        if (type === 'items') msg = upsertItem(app.db, row);
        else if (type === 'employees') msg = upsertEmployee(app.db, row);
        else msg = upsertDepot(app.db, row);
        results.push({ row: i + 1, success: true, message: msg });
      } catch (err) {
        results.push({ row: i + 1, success: false, reason: String(err.message || err) });
      }
    }

    const okCount = results.filter(r => r.success).length;
    return reply.send({
      ok: true,
      type,
      total: results.length,
      success: okCount,
      failed: results.length - okCount,
      results,
    });
  });
}

// ---------- items ----------
function upsertItem(db, row) {
  const { id, name, category, unit, stock, min_stock, unit_cost, depot_id } = row || {};
  if (!id || !name || !unit || stock == null || min_stock == null || unit_cost == null || !depot_id) {
    throw new Error('缺少必填字段(id/name/unit/stock/min_stock/unit_cost/depot_id)');
  }
  const dep = db.prepare('SELECT id FROM depot WHERE id = ?').get(depot_id);
  if (!dep) throw new Error(`仓库 ${depot_id} 不存在`);
  const s = Number(stock), m = Number(min_stock), c = Number(unit_cost);
  if (!Number.isFinite(s) || s < 0) throw new Error('stock 须为 >=0 的数字');
  if (!Number.isFinite(m) || m < 0) throw new Error('min_stock 须为 >=0 的数字');
  if (!Number.isFinite(c) || c < 0) throw new Error('unit_cost 须为 >=0 的数字');

  // 幂等 UPSERT
  const info = db.prepare(
    `INSERT INTO inventory_item (id, name, category, unit, stock, min_stock, unit_cost, depot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, depot_id) DO UPDATE SET
       name=excluded.name, category=excluded.category, unit=excluded.unit,
       stock=excluded.stock, min_stock=excluded.min_stock, unit_cost=excluded.unit_cost,
       updated_at=CURRENT_TIMESTAMP`
  ).run(id, name, category || 'consumable', unit, s, m, c, depot_id);

  return `物资 ${id}@${depot_id} 已导入(stock=${s})`;
}

// ---------- employees ----------
function upsertEmployee(db, row) {
  const { employee_id, name, position, department, account, password } = row || {};
  if (!employee_id || !name || !account) {
    throw new Error('缺少必填字段(employee_id/name/account)');
  }
  const eid = Number(employee_id);
  if (!Number.isInteger(eid) || eid <= 0) throw new Error('employee_id 须为正整数');

  let pwdHash = null;
  if (password) {
    if (password.length < 8) throw new Error('密码至少 8 位');
    pwdHash = bcrypt.hashSync(password, 10);
  }

  // 检查 account 唯一(排除自身)
  const dup = db.prepare('SELECT employee_id FROM employees WHERE account = ? AND employee_id != ?').get(account, eid);
  if (dup) throw new Error(`账号 ${account} 已被工号 ${dup.employee_id} 占用`);

  const info = db.prepare(
    `INSERT INTO employees (employee_id, name, position, department, account, password_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id) DO UPDATE SET
       name=excluded.name, position=excluded.position, department=excluded.department,
       account=excluded.account,
       password_hash=COALESCE(excluded.password_hash, employees.password_hash)`
  ).run(eid, name, position || null, department || null, account, pwdHash);

  return `员工 ${eid}(${name}) 已导入`;
}

// ---------- depots ----------
function upsertDepot(db, row) {
  const { id, name, is_active } = row || {};
  if (!id || !name) throw new Error('缺少必填字段(id/name)');
  const active = is_active == null ? 1 : (Number(is_active) ? 1 : 0);

  db.prepare(
    `INSERT INTO depot (id, name, is_active) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_active=excluded.is_active`
  ).run(id, name, active);

  return `仓库 ${id}(${name}) 已导入(is_active=${active})`;
}

module.exports = { registerSeedImportRoutes, TYPES };
