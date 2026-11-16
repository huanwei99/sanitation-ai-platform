-- 009_rental_ledger.sql — P1-T03 外租设备台账
-- 需求:租入/归还留痕,与自有资产分开列示(区别于自有库存台账)
-- 设计:
--   1. 复用 inventory_item.is_rented 作为"可外租物资"标记(001 已预留,避免与 is_rentable 冗余)
--   2. rental_contract 合同主表(租入/归还全生命周期)
--   3. rental_item 设备明细(每台一条,关联 inventory_item,记录序列号/租金)
-- 计费:归还时按 日租金 × 租期天数 结算(简化,不含月租/超时罚款)

-- ---- 1. 外租合同 ----
CREATE TABLE IF NOT EXISTS rental_contract (
  id            TEXT PRIMARY KEY,                    -- RC-2026-0001
  contract_no   TEXT,                                -- 外部合同号(可选)
  supplier      TEXT    NOT NULL,                    -- 出租方
  department    TEXT,                                -- 使用部门
  depot_id      TEXT NOT NULL DEFAULT 'DP-001' REFERENCES depot(id),
  start_date    TEXT    NOT NULL,                    -- YYYY-MM-DD
  end_date      TEXT,                                -- 预计归还日(可空=长期)
  status        TEXT    NOT NULL CHECK(status IN ('active','returned','cancelled')) DEFAULT 'active',
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES employees(employee_id),
  returned_at   TIMESTAMP,
  return_actor  INTEGER REFERENCES employees(employee_id),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rental_contract_status ON rental_contract(status);
CREATE INDEX IF NOT EXISTS idx_rental_contract_depot  ON rental_contract(depot_id);

-- ---- 2. 外租设备明细 ----
CREATE TABLE IF NOT EXISTS rental_item (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id     TEXT    NOT NULL REFERENCES rental_contract(id),
  item_id         TEXT    NOT NULL,                    -- 关联 inventory_item.id(可外租物资)
  serial_no       TEXT,                                -- 序列号/车牌
  qty             INTEGER NOT NULL DEFAULT 1 CHECK(qty > 0),
  day_rate        INTEGER NOT NULL DEFAULT 0,          -- 日租金(分)
  status          TEXT    NOT NULL CHECK(status IN ('rented','returned')) DEFAULT 'rented',
  rent_in_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  returned_at     TIMESTAMP,
  return_note     TEXT,
  return_fee      INTEGER                              -- 归还结算租金(分,归还时写)
);
CREATE INDEX IF NOT EXISTS idx_rental_item_contract ON rental_item(contract_id);
CREATE INDEX IF NOT EXISTS idx_rental_item_item     ON rental_item(item_id);
CREATE INDEX IF NOT EXISTS idx_rental_item_status   ON rental_item(status);
