// rental.js — P1-T03 外租设备台账 API
// 需求:租入/归还留痕,与自有资产分开列示;合同粒度管理;按日租金结算。
//
// 路由:
//   POST /rental/contracts          创建外租合同(含设备明细,状态 active)
//   GET  /rental/contracts          列表(分页+筛选 status/depot_id/supplier)
//   GET  /rental/contracts/:id      详情(含设备明细)
//   POST /rental/contracts/:id/return  归还(部分或全部设备,结算租金)
//   POST /rental/contracts/:id/cancel  取消合同(仅 active 且无已归还设备)
//   GET  /rental/summary            台账汇总(自有 vs 外租)
//   GET  /rental/contracts/:id/chain 哈希链校验

const { recordEvent, verifyChain } = require('./chain');
const { readIdempotency, writeIdempotency, ApiError } = require('./distribution');

// ---------- 权限 ----------
// 外租操作权:admin_level>=1 或 modules.inventory 带 edit/ALL
function canManageRental(db, employeeId) {
  const p = db.prepare('SELECT admin_level, modules FROM permissions WHERE employee_id = ?').get(employeeId);
  if (!p) return false;
  if (p.admin_level >= 1) return true;
  let mods = {};
  try { mods = JSON.parse(p.modules || '{}'); } catch { mods = {}; }
  const inv = mods.inventory;
  return Array.isArray(inv) && (inv.includes('edit') || inv.includes('ALL'));
}

// 单据可见性
function canViewRental(db, employeeId, contractId) {
  if (canManageRental(db, employeeId)) return true;
  const c = db.prepare('SELECT created_by FROM rental_contract WHERE id = ?').get(contractId);
  return c && c.created_by === employeeId;
}

// ---------- 单号 RC-{year}-{seq} ----------
function nextContractId(db) {
  const year = new Date().getFullYear();
  const prefix = `RC-${year}-`;
  const maxRow = db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) AS m FROM rental_contract WHERE id LIKE ?`
  ).get(prefix.length + 1, `${prefix}%`);
  const seq = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ---------- 创建外租合同 POST /rental/contracts ----------
async function createRentalContract(app, req, reply) {
  const body = req.body || {};
  const idem = readIdempotency(app.db, req.headers['idempotency-key'],
                               'POST /rental/contracts', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canManageRental(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无外租管理权限' });
  }
  const {
    contract_no = null, supplier, department = null,
    depot_id = 'DP-001', start_date, end_date = null, note = null, items,
  } = body;

  if (!supplier) return reply.code(400).send({ ok: false, error: '需要 supplier(出租方)' });
  if (!start_date) return reply.code(400).send({ ok: false, error: '需要 start_date' });
  if (!Array.isArray(items) || items.length === 0) {
    return reply.code(400).send({ ok: false, error: '需要 items(至少一台设备)' });
  }

  const dep = app.db.prepare('SELECT id FROM depot WHERE id = ?').get(depot_id);
  if (!dep) return reply.code(404).send({ ok: false, error: `仓库 ${depot_id} 不存在` });

  // 校验 items:item_id 必须是 is_rentable 物资(A-T13 同理:跨仓拒)
  let lines;
  try {
    lines = items.map((it, idx) => {
      const { item_id, serial_no = null, qty = 1, day_rate = 0 } = it;
      if (!item_id) throw new ApiError(400, { ok: false, error: `第 ${idx + 1} 行 item_id 必填` });
      if (qty < 1) throw new ApiError(400, { ok: false, error: `第 ${idx + 1} 行 qty 须 >= 1` });
      if (day_rate < 0) throw new ApiError(400, { ok: false, error: `第 ${idx + 1} 行 day_rate 须 >= 0` });

      const inv = app.db.prepare(
        'SELECT id, depot_id, is_rented, name FROM inventory_item WHERE id = ? AND depot_id = ?'
      ).get(item_id, depot_id);
      if (!inv) {
        const elsewhere = app.db.prepare(
          'SELECT depot_id FROM inventory_item WHERE id = ? LIMIT 1'
        ).get(item_id);
        if (elsewhere && elsewhere.depot_id !== depot_id) {
          throw new ApiError(400, {
            ok: false, code: 'DEPOT_MISMATCH',
            error: `物资 ${item_id} 属于仓 ${elsewhere.depot_id},不能从 ${depot_id} 外租登记`,
            item_id, item_depot: elsewhere.depot_id, requested_depot: depot_id,
          });
        }
        throw new ApiError(404, { ok: false, error: `物资 ${item_id} 不存在或不在仓库 ${depot_id}` });
      }
      if (!inv.is_rented) {
        throw new ApiError(400, {
          ok: false, error: `物资 ${item_id}(${inv.name})未标记为可外租`,
          item_id,
        });
      }
      return { item_id, serial_no, qty, day_rate };
    });
  } catch (e) {
    if (e instanceof ApiError) return reply.code(e.status).send(e.body);
    throw e;
  }

  const contractId = nextContractId(app.db);

  app.db.transaction(() => {
    app.db.prepare(
      `INSERT INTO rental_contract (id, contract_no, supplier, department, depot_id,
                                    start_date, end_date, status, note, created_by)
       VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`
    ).run(contractId, contract_no, supplier, department, depot_id,
          start_date, end_date, note, req.principal.employee_id);

    for (const ln of lines) {
      app.db.prepare(
        `INSERT INTO rental_item (contract_id, item_id, serial_no, qty, day_rate, status, rent_in_at)
         VALUES (?,?,?,?,?, 'rented', CURRENT_TIMESTAMP)`
      ).run(contractId, ln.item_id, ln.serial_no, ln.qty, ln.day_rate);
    }

    recordEvent(app.db, {
      ref_type: 'rental', ref_id: contractId, step_no: 0,
      event: 'rent_created',
      actor_id: req.principal.employee_id,
      actor_role: '库管员',
      payload: {
        action: 'create', supplier, depot_id, start_date, end_date,
        items: lines.map(l => ({ item_id: l.item_id, serial_no: l.serial_no, qty: l.qty, day_rate: l.day_rate })),
      },
    });
  })();

  const result = { ok: true, id: contractId, status: 'active', items: lines.length };
  writeIdempotency(app.db, req.headers['idempotency-key'],
                   'POST /rental/contracts', req.principal.employee_id, 201, result);
  return reply.code(201).send(result);
}

// ---------- 归还 POST /rental/contracts/:id/return ----------
// 支持部分归还(rental_item_ids 指定要归还的设备明细行;不传则归还所有 rented)
async function returnRental(app, req, reply) {
  const { id } = req.params;
  const body = req.body || {};
  const idem = readIdempotency(app.db, req.headers['idempotency-key'],
                               'POST /rental/contracts/:id/return', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canManageRental(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无外租管理权限' });
  }

  const contract = app.db.prepare('SELECT * FROM rental_contract WHERE id = ?').get(id);
  if (!contract) return reply.code(404).send({ ok: false, error: `外租合同 ${id} 不存在` });
  if (contract.status !== 'active') {
    return reply.code(400).send({ ok: false, error: `合同状态 ${contract.status},仅 active 可归还` });
  }

  const { rental_item_ids = null, return_note = null, return_date = null } = body;

  // 确定要归还的明细行
  let rows;
  if (Array.isArray(rental_item_ids) && rental_item_ids.length > 0) {
    const ids = rental_item_ids.map(Number).filter(n => Number.isInteger(n));
    if (ids.length === 0) {
      return reply.code(400).send({ ok: false, error: 'rental_item_ids 非法' });
    }
    const placeholders = ids.map(() => '?').join(',');
    rows = app.db.prepare(
      `SELECT * FROM rental_item WHERE contract_id = ? AND status = 'rented' AND id IN (${placeholders})`
    ).all(id, ...ids);
    if (rows.length === 0) {
      return reply.code(400).send({ ok: false, error: '指定设备行不存在或已归还' });
    }
  } else {
    rows = app.db.prepare(
      `SELECT * FROM rental_item WHERE contract_id = ? AND status = 'rented'`
    ).all(id);
    if (rows.length === 0) {
      return reply.code(400).send({ ok: false, error: '合同下无待归还设备' });
    }
  }

  // 计算租金:日租金 × 租期天数(最少 1 天)
  const retDate = return_date || new Date().toISOString().slice(0, 10);
  let totalFee = 0;
  const now = new Date();
  for (const r of rows) {
    const rentIn = new Date(r.rent_in_at || contract.start_date);
    const diffMs = now - rentIn;
    const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const fee = r.day_rate * days * r.qty;
    totalFee += fee;
  }

  app.db.transaction(() => {
    for (const r of rows) {
      const rentIn = new Date(r.rent_in_at || contract.start_date);
      const diffMs = now - rentIn;
      const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      const fee = r.day_rate * days * r.qty;
      app.db.prepare(
        `UPDATE rental_item
            SET status = 'returned', returned_at = CURRENT_TIMESTAMP,
                return_note = ?, return_fee = ?
          WHERE id = ?`
      ).run(return_note, fee, r.id);
    }

    // 检查是否全部归还 → 合同状态推到 returned
    const remaining = app.db.prepare(
      `SELECT COUNT(*) AS c FROM rental_item WHERE contract_id = ? AND status = 'rented'`
    ).get(id).c;
    if (remaining === 0) {
      app.db.prepare(
        `UPDATE rental_contract
            SET status = 'returned', returned_at = CURRENT_TIMESTAMP, return_actor = ?
          WHERE id = ?`
      ).run(req.principal.employee_id, id);
    }

    recordEvent(app.db, {
      ref_type: 'rental', ref_id: id, step_no: 1,
      event: 'rent_returned',
      actor_id: req.principal.employee_id,
      actor_role: req.principal.position || '库管员',
      payload: {
        returned_items: rows.map(r => ({ id: r.id, item_id: r.item_id, qty: r.qty })),
        total_fee: totalFee,
        return_date: retDate,
        note: return_note,
        contract_closed: remaining === 0,
      },
    });
  })();

  const after = app.db.prepare('SELECT status FROM rental_contract WHERE id = ?').get(id);
  const result = {
    ok: true, id,
    contract_status: after.status,
    returned_count: rows.length,
    total_fee: totalFee,
  };
  writeIdempotency(app.db, req.headers['idempotency-key'],
                   'POST /rental/contracts/:id/return', req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 取消 POST /rental/contracts/:id/cancel ----------
async function cancelRental(app, req, reply) {
  const { id } = req.params;
  const idem = readIdempotency(app.db, req.headers['idempotency-key'],
                               'POST /rental/contracts/:id/cancel', req.principal.employee_id);
  if (idem) return reply.code(idem.status).send(idem.body);

  if (!canManageRental(app.db, req.principal.employee_id)) {
    return reply.code(403).send({ ok: false, error: '无外租管理权限' });
  }

  const contract = app.db.prepare('SELECT * FROM rental_contract WHERE id = ?').get(id);
  if (!contract) return reply.code(404).send({ ok: false, error: `外租合同 ${id} 不存在` });
  if (contract.status !== 'active') {
    return reply.code(400).send({ ok: false, error: `合同状态 ${contract.status},仅 active 可取消` });
  }

  // 有已归还设备不可取消
  const returned = app.db.prepare(
    `SELECT COUNT(*) AS c FROM rental_item WHERE contract_id = ? AND status = 'returned'`
  ).get(id).c;
  if (returned > 0) {
    return reply.code(400).send({ ok: false, error: '合同下有已归还设备,不可取消(请走归还流程)' });
  }

  const note = req.body?.note || null;
  app.db.transaction(() => {
    app.db.prepare(
      `UPDATE rental_contract SET status = 'cancelled' WHERE id = ?`
    ).run(id);
    // 设备也标记为 returned(退回,不计租金)
    app.db.prepare(
      `UPDATE rental_item SET status = 'returned', returned_at = CURRENT_TIMESTAMP,
              return_note = '合同取消' WHERE contract_id = ? AND status = 'rented'`
    ).run(id);

    recordEvent(app.db, {
      ref_type: 'rental', ref_id: id, step_no: 0,
      event: 'cancel',
      actor_id: req.principal.employee_id,
      actor_role: '库管员',
      payload: { action: 'cancel', note },
    });
  })();

  const result = { ok: true, id, status: 'cancelled' };
  writeIdempotency(app.db, req.headers['idempotency-key'],
                   'POST /rental/contracts/:id/cancel', req.principal.employee_id, 200, result);
  return reply.send(result);
}

// ---------- 列表 GET /rental/contracts ----------
async function listRentals(app, req, reply) {
  const me = req.principal.employee_id;
  const privileged = canManageRental(app.db, me);

  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  if (!privileged) {
    where.push('c.created_by = ?');
    params.push(me);
  }
  if (q.status) { where.push('c.status = ?'); params.push(q.status); }
  if (q.depot_id) { where.push('c.depot_id = ?'); params.push(q.depot_id); }
  if (q.supplier) { where.push('c.supplier LIKE ?'); params.push(`%${q.supplier}%`); }
  if (q.department) { where.push('c.department = ?'); params.push(q.department); }
  if (q.from) { where.push('DATE(c.start_date) >= DATE(?)'); params.push(q.from); }
  if (q.to) { where.push('DATE(c.start_date) <= DATE(?)'); params.push(q.to); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = app.db.prepare(
    `SELECT COUNT(*) AS cnt FROM rental_contract c ${whereSql}`
  ).get(...params).cnt;
  const items = app.db.prepare(
    `SELECT c.id, c.contract_no, c.supplier, c.department, c.depot_id,
            c.start_date, c.end_date, c.status, c.note,
            c.created_by, c.returned_at,
            (SELECT COUNT(*) FROM rental_item ri WHERE ri.contract_id = c.id) AS total_items,
            (SELECT COUNT(*) FROM rental_item ri WHERE ri.contract_id = c.id AND ri.status = 'rented') AS rented_items,
            (SELECT COALESCE(SUM(ri.day_rate * ri.qty), 0) FROM rental_item ri WHERE ri.contract_id = c.id) AS daily_cost
       FROM rental_contract c ${whereSql}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return reply.send({
    ok: true, page, limit, total,
    pages: Math.ceil(total / limit),
    items,
  });
}

// ---------- 详情 GET /rental/contracts/:id ----------
async function getRental(app, req, reply) {
  const { id } = req.params;
  if (!canViewRental(app.db, req.principal.employee_id, id)) {
    return reply.code(403).send({ ok: false, error: '无权查看该外租合同' });
  }
  const contract = app.db.prepare('SELECT * FROM rental_contract WHERE id = ?').get(id);
  if (!contract) return reply.code(404).send({ ok: false, error: `外租合同 ${id} 不存在` });

  const items = app.db.prepare(
    `SELECT ri.id, ri.item_id, ii.name AS item_name, ii.spec,
            ri.serial_no, ri.qty, ri.day_rate, ri.status,
            ri.rent_in_at, ri.returned_at, ri.return_note, ri.return_fee,
            ii.is_rented
       FROM rental_item ri
       JOIN inventory_item ii ON ii.id = ri.item_id AND ii.depot_id = ?
      WHERE ri.contract_id = ?
      ORDER BY ri.id`
  ).all(contract.depot_id, id);

  const rentedItems = items.filter(x => x.status === 'rented').length;

  return reply.send({
    ok: true,
    contract: { ...contract, items, rented_items: rentedItems, total_items: items.length },
  });
}

// ---------- 台账汇总 GET /rental/summary ----------
async function rentalSummary(app, req, reply) {
  const q = req.query || {};
  const depotFilter = q.depot_id ? 'AND i.depot_id = ?' : '';
  const params = q.depot_id ? [q.depot_id] : [];

  // 外租物资(库存中 is_rented=1)
  const rentable = app.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(i.stock * i.unit_cost), 0) AS total_value
       FROM inventory_item i WHERE i.is_rented = 1 ${depotFilter}`
  ).get(...params);

  // 当前外租中的设备台数
  const activeRented = app.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(ri.day_rate * ri.qty), 0) AS daily_cost
       FROM rental_item ri
       JOIN rental_contract rc ON rc.id = ri.contract_id
      WHERE ri.status = 'rented' AND rc.status = 'active'
        ${q.depot_id ? 'AND rc.depot_id = ?' : ''}`
  ).get(...(q.depot_id ? [q.depot_id] : []));

  // 历史归还统计
  const returnedStats = app.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(ri.return_fee), 0) AS total_fees
       FROM rental_item ri WHERE ri.status = 'returned'`
  ).get();

  return reply.send({
    ok: true,
    rentable_assets: rentable,
    currently_rented: activeRented,
    returned_history: returnedStats,
  });
}

// ---------- 哈希链 GET /rental/contracts/:id/chain ----------
async function getRentalChain(app, req, reply) {
  const { id } = req.params;
  if (!canViewRental(app.db, req.principal.employee_id, id)) {
    return reply.code(403).send({ ok: false, error: '无权查看该合同审计链' });
  }
  const v = verifyChain(app.db, 'rental', id);
  return reply.send({ ok: true, id, ...v });
}

// ---------- 注册路由 ----------
async function registerRentalRoutes(app) {
  if (!app.db) {
    app.log.warn('[rental] db 不可用,跳过 rental 路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('rental 路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  app.post('/rental/contracts', preAuth, async (req, reply) => createRentalContract(app, req, reply));
  app.get('/rental/contracts', preAuth, async (req, reply) => listRentals(app, req, reply));
  app.get('/rental/contracts/:id', preAuth, async (req, reply) => getRental(app, req, reply));
  app.post('/rental/contracts/:id/return', preAuth, async (req, reply) => returnRental(app, req, reply));
  app.post('/rental/contracts/:id/cancel', preAuth, async (req, reply) => cancelRental(app, req, reply));
  app.get('/rental/summary', preAuth, async (req, reply) => rentalSummary(app, req, reply));
  app.get('/rental/contracts/:id/chain', preAuth, async (req, reply) => getRentalChain(app, req, reply));
}

module.exports = {
  registerRentalRoutes, canManageRental, canViewRental, nextContractId,
};
