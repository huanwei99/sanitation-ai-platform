-- 002_multi_depot.sql — 多仓支持(决策 #3:多仓)
-- 模型:每个库存行归属唯一仓库;同一物资在多仓 = 多行(各仓独立编码/库存)。
-- 发放/领取/入库必须指定出库(或入库)仓库;流水按仓记账;库存校验按(仓,物资)隔离。

-- 仓库主数据
CREATE TABLE IF NOT EXISTS depot (
  id        TEXT PRIMARY KEY,            -- DP-001
  name      TEXT    NOT NULL,            -- 总部仓 / 片区二仓 …
  is_active INTEGER NOT NULL DEFAULT 1
);

-- 库存行挂仓
ALTER TABLE inventory_item ADD COLUMN depot_id TEXT NOT NULL DEFAULT 'DP-001'
  REFERENCES depot(id);
CREATE INDEX IF NOT EXISTS idx_inventory_depot ON inventory_item(depot_id);

-- 流水挂仓(冗余存列,审计时免联表)
ALTER TABLE stock_movement ADD COLUMN depot_id TEXT NOT NULL DEFAULT 'DP-001'
  REFERENCES depot(id);
CREATE INDEX IF NOT EXISTS idx_movement_depot ON stock_movement(depot_id, item_id, occurred_at);

-- 单据指定仓库(发放/领取/入库)
ALTER TABLE distribution   ADD COLUMN depot_id TEXT NOT NULL DEFAULT 'DP-001' REFERENCES depot(id);
ALTER TABLE requisition    ADD COLUMN depot_id TEXT NOT NULL DEFAULT 'DP-001' REFERENCES depot(id);
ALTER TABLE inbound_record ADD COLUMN depot_id TEXT NOT NULL DEFAULT 'DP-001' REFERENCES depot(id);

-- 默认仓库(迁移内置,业务可再增)
INSERT OR IGNORE INTO depot(id, name) VALUES ('DP-001', '总部仓'), ('DP-002', '片区二仓');

-- ============ 已定决策落库(2026-11-13) ============
-- 决策 #1:审批强制前置 → 维持 true(001 中默认值即为 true,此处显式重申)
-- 决策 #2:一线有手机+账号 → self-only 签收维持 true(无兜底 PIN 需求)
INSERT OR IGNORE INTO org_policy(key, value) VALUES
  ('distribution.require_approval', 'true'),
  ('signoff.self_only', 'true');
