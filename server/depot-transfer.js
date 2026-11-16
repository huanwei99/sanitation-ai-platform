// depot-transfer.js — P0-T04 仓间调拨最小版
// 两步:移出(ship out)+ 移入(receive in),各记 stock_movement 流水。
//
// POST /depot-transfers           创建调拨单并执行移出(扣源仓库存,记 transfer_out)
// POST /depot-transfers/:id/receive  执行移入(增目标仓库存,记 transfer_in)

const { readIdempotency, writeIdempotency } = require('./distribution');

function nextTransferId(db) {
  const year = new Date().getFullYear();
  const row = db.prepare(
    `SELECT COUNT(*) c FROM depot_transfer WHERE id LIKE ?`
  ).get(`DT-${year}-%`);
  const seq = String(row.c + 1).padStart(4, '0');
  return `DT-${year}-${seq}`;
}

async function registerDepotTransferRoutes(app) {
  // ---- POST /depot-transfers (创建 + 移出) ----
  app.post('/depot-transfers', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    const idem = readIdempotency(app.db, req.headers['idempotency-key'], 'POST /depot-transfers', req.principal.employee_id);
    if (idem) return reply.code(idem.status).send(idem.body);

    const { from_depot, to_depot, items, remark } = req.body || {};
    if (!from_depot || !to_depot || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ ok: false, error: '需要 from_depot/to_depot/items' });
    }
    if (from_depot === to_depot) {
      return reply.code(400).send({ ok: false, error: '调出仓与调入仓不能相同' });
    }

    // 校验仓库存在
    const fromDep = app.db.prepare('SELECT id FROM depot WHERE id = ? AND is_active = 1').get(from_depot);
    const toDep = app.db.prepare('SELECT id FROM depot WHERE id = ? AND is_active = 1').get(to_depot);
    if (!fromDep) return reply.code(404).send({ ok: false, error: `调出仓 ${from_depot} 不存在` });
    if (!toDep) return reply.code(404).send({ ok: false, error: `调入仓 ${to_depot} 不存在` });

    const id = nextTransferId(app.db);
    const actorId = req.principal.employee_id;
    let totalQty = 0;

    try {
      app.db.transaction(() => {
        // 写调拨单主表
        app.db.prepare(
          `INSERT INTO depot_transfer (id, from_depot, to_depot, status, total_qty, actor_id, remark)
           VALUES (?, ?, ?, 'shipped', 0, ?, ?)`
        ).run(id, from_depot, to_depot, actorId, remark || null);

        items.forEach((it, idx) => {
          const itemId = it.item_id;
          const qty = Number(it.qty);
          if (!itemId || !qty || qty < 1) throw new Error(`第 ${idx + 1} 行 item_id/qty 非法`);
          totalQty += qty;

          // 源仓库存校验 + 扣减
          const inv = app.db.prepare(
            'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
          ).get(itemId, from_depot);
          if (!inv) throw new Error(`物资 ${itemId} 不在调出仓 ${from_depot}`);
          if (inv.stock < qty) throw new Error(`物资 ${itemId} 库存不足(调出仓 ${from_depot} 仅 ${inv.stock})`);

          app.db.prepare(
            'UPDATE inventory_item SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND depot_id = ?'
          ).run(qty, itemId, from_depot);

          // 写调拨行
          app.db.prepare(
            'INSERT INTO depot_transfer_line (transfer_id, item_id, qty, line_no) VALUES (?, ?, ?, ?)'
          ).run(id, itemId, qty, idx + 1);

          // 记流水 transfer_out
          const after = app.db.prepare(
            'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
          ).get(itemId, from_depot).stock;
          app.db.prepare(
            `INSERT INTO stock_movement (item_id, depot_id, delta, reason, ref_type, ref_id, line_no, qty_after, actor_id)
             VALUES (?, ?, ?, 'transfer_out', 'depot_transfer', ?, ?, ?, ?)`
          ).run(itemId, from_depot, -qty, id, idx + 1, after, actorId);
        });

        // 更新 total_qty
        app.db.prepare('UPDATE depot_transfer SET total_qty = ? WHERE id = ?').run(totalQty, id);
      })();
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('库存不足')) return reply.code(409).send({ ok: false, error: msg });
      if (msg.includes('不存在') || msg.includes('不在调出仓')) return reply.code(404).send({ ok: false, error: msg });
      return reply.code(400).send({ ok: false, error: msg });
    }

    const result = { ok: true, id, from_depot, to_depot, status: 'shipped', total_qty: totalQty };
    writeIdempotency(app.db, req.headers['idempotency-key'], 'POST /depot-transfers', actorId, 201, result);
    return reply.code(201).send(result);
  });

  // ---- POST /depot-transfers/:id/receive (移入) ----
  app.post('/depot-transfers/:id/receive', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    const { id } = req.params;
    const transfer = app.db.prepare('SELECT * FROM depot_transfer WHERE id = ?').get(id);
    if (!transfer) return reply.code(404).send({ ok: false, error: `调拨单 ${id} 不存在` });
    if (transfer.status === 'received') {
      return reply.code(400).send({ ok: false, error: '该调拨单已完成移入' });
    }

    const receiverId = req.principal.employee_id;
    const lines = app.db.prepare(
      'SELECT item_id, qty, line_no FROM depot_transfer_line WHERE transfer_id = ? ORDER BY line_no'
    ).all(id);

    app.db.transaction(() => {
      for (const ln of lines) {
        // 目标仓:存在则加库存,不存在则新建行
        const existing = app.db.prepare(
          'SELECT stock, name, category, unit, min_stock, unit_cost FROM inventory_item WHERE id = ? AND depot_id = ?'
        ).get(ln.item_id, transfer.to_depot);

        if (existing) {
          app.db.prepare(
            'UPDATE inventory_item SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND depot_id = ?'
          ).run(ln.qty, ln.item_id, transfer.to_depot);
        } else {
          // 从源仓拷贝物资元数据(若源仓还有)或用默认值
          const src = app.db.prepare(
            'SELECT name, category, unit, min_stock, unit_cost FROM inventory_item WHERE id = ? AND depot_id = ?'
          ).get(ln.item_id, transfer.from_depot);
          app.db.prepare(
            `INSERT INTO inventory_item (id, name, category, unit, stock, min_stock, unit_cost, depot_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(ln.item_id,
            src?.name || ln.item_id,
            src?.category || 'consumable',
            src?.unit || '个',
            ln.qty,
            src?.min_stock || 0,
            src?.unit_cost || 0,
            transfer.to_depot);
        }

        // 记流水 transfer_in
        const after = app.db.prepare(
          'SELECT stock FROM inventory_item WHERE id = ? AND depot_id = ?'
        ).get(ln.item_id, transfer.to_depot).stock;
        app.db.prepare(
          `INSERT INTO stock_movement (item_id, depot_id, delta, reason, ref_type, ref_id, line_no, qty_after, actor_id)
           VALUES (?, ?, ?, 'transfer_in', 'depot_transfer', ?, ?, ?, ?)`
        ).run(ln.item_id, transfer.to_depot, ln.qty, id, ln.line_no, after, receiverId);
      }

      app.db.prepare(
        `UPDATE depot_transfer SET status = 'received', receiver_id = ?, received_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(receiverId, id);
    })();

    return reply.send({ ok: true, id, status: 'received', received_by: receiverId });
  });
}

module.exports = { registerDepotTransferRoutes };
