-- 007_depot_transfer.sql — P0-T04 仓间调拨最小版
-- 核心改动:
--   1. inventory_item 主键改为 (id, depot_id),支持同物资多仓并存
--   2. stock_movement reason/ref_type 扩展 transfer_out/transfer_in + depot_transfer
--   3. 新增 depot_transfer 表(移出+移入两步)
--   4. 重建 005 的 append-only 触发器(重建表会带走触发器)

-- ---- 先拆 005 触发器(重建表会自动 DROP,这里显式清理) ----
DROP TRIGGER IF EXISTS trg_stock_movement_no_update;
DROP TRIGGER IF EXISTS trg_stock_movement_no_delete;

-- ---- 1. inventory_item 复合主键 (id, depot_id) ----
CREATE TABLE inventory_item_new (
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  spec        TEXT,
  category    TEXT NOT NULL CHECK(category IN ('consumable','tool','spare','office')),
  unit        TEXT NOT NULL,
  stock       INTEGER NOT NULL CHECK(stock >= 0),
  min_stock   INTEGER NOT NULL,
  location    TEXT,
  unit_cost   INTEGER NOT NULL,
  is_rented   INTEGER NOT NULL DEFAULT 0,
  depot_id    TEXT NOT NULL DEFAULT 'DP-001' REFERENCES depot(id),
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, depot_id)
);
INSERT INTO inventory_item_new
  SELECT id, name, spec, category, unit, stock, min_stock, location, unit_cost, is_rented, depot_id, updated_at
  FROM inventory_item;
DROP TABLE inventory_item;
ALTER TABLE inventory_item_new RENAME TO inventory_item;
CREATE INDEX IF NOT EXISTS idx_inventory_depot ON inventory_item(depot_id);

-- ---- 2. stock_movement 扩展 reason/ref_type,加复合 FK ----
CREATE TABLE stock_movement_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL,
  depot_id    TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL CHECK(reason IN ('inbound','distribution_out','requisition_out','adjustment','return','transfer_out','transfer_in')),
  ref_type    TEXT NOT NULL CHECK(ref_type IN ('inbound','distribution','requisition','depot_transfer')),
  ref_id      TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  qty_after   INTEGER NOT NULL,
  actor_id    INTEGER NOT NULL REFERENCES employees(employee_id),
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id, depot_id) REFERENCES inventory_item(id, depot_id)
);
INSERT INTO stock_movement_new (id, item_id, depot_id, delta, reason, ref_type, ref_id, line_no, qty_after, actor_id, occurred_at)
  SELECT sm.id, sm.item_id, sm.depot_id, sm.delta, sm.reason, sm.ref_type, sm.ref_id, sm.line_no, sm.qty_after, sm.actor_id, sm.occurred_at
  FROM stock_movement sm;
DROP TABLE stock_movement;
ALTER TABLE stock_movement_new RENAME TO stock_movement;
CREATE INDEX IF NOT EXISTS idx_movement_item ON stock_movement(item_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_movement_ref  ON stock_movement(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_movement_depot ON stock_movement(depot_id, item_id, occurred_at);

-- ---- 2b. 修复 line 表 FK: inventory_item 主键改为 (id,depot_id) 后,
--         distribution_line / requisition_line / inbound_line 的
--         REFERENCES inventory_item(id) 已失效。去掉该 FK(行表通过父单 depot_id 间接归属仓)。
CREATE TABLE distribution_line_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id TEXT    NOT NULL REFERENCES distribution(id),
  line_no         INTEGER NOT NULL,
  item_id         TEXT    NOT NULL,
  per_person_qty  INTEGER NOT NULL CHECK(per_person_qty > 0),
  qty             INTEGER NOT NULL CHECK(qty > 0)
);
INSERT INTO distribution_line_new SELECT * FROM distribution_line;
DROP TABLE distribution_line;
ALTER TABLE distribution_line_new RENAME TO distribution_line;

CREATE TABLE requisition_line_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id TEXT    NOT NULL REFERENCES requisition(id),
  line_no        INTEGER NOT NULL,
  item_id        TEXT    NOT NULL,
  qty            INTEGER NOT NULL CHECK(qty > 0)
);
INSERT INTO requisition_line_new SELECT * FROM requisition_line;
DROP TABLE requisition_line;
ALTER TABLE requisition_line_new RENAME TO requisition_line;

CREATE TABLE inbound_line_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  inbound_id  TEXT    NOT NULL REFERENCES inbound_record(id),
  line_no     INTEGER NOT NULL,
  item_id     TEXT    NOT NULL,
  qty         INTEGER NOT NULL CHECK(qty > 0),
  unit_cost   INTEGER NOT NULL
);
INSERT INTO inbound_line_new SELECT * FROM inbound_line;
DROP TABLE inbound_line;
ALTER TABLE inbound_line_new RENAME TO inbound_line;

-- ---- 重建 005 stock_movement append-only 触发器 ----
CREATE TRIGGER trg_stock_movement_no_update
BEFORE UPDATE ON stock_movement
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'stock_movement is append-only: UPDATE blocked (A2 guard)');
END;
CREATE TRIGGER trg_stock_movement_no_delete
BEFORE DELETE ON stock_movement
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'stock_movement is append-only: DELETE blocked (A2 guard)');
END;

-- ---- 3. depot_transfer 调拨单 ----
CREATE TABLE IF NOT EXISTS depot_transfer (
  id          TEXT PRIMARY KEY,                              -- DT-YYYY-NNNN
  from_depot  TEXT NOT NULL REFERENCES depot(id),
  to_depot    TEXT NOT NULL REFERENCES depot(id),
  status      TEXT NOT NULL CHECK(status IN ('shipped','received')) DEFAULT 'shipped',
  total_qty   INTEGER NOT NULL,
  actor_id    INTEGER NOT NULL REFERENCES employees(employee_id),   -- 移出操作人
  receiver_id INTEGER REFERENCES employees(employee_id),            -- 移入操作人
  remark      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS depot_transfer_line (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES depot_transfer(id),
  item_id     TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK(qty > 0),
  line_no     INTEGER NOT NULL
);

-- 多增一个 depot 种子(演练用 DP-002)
INSERT OR IGNORE INTO depot (id, name, is_active) VALUES ('DP-002', '片区二仓', 1);
