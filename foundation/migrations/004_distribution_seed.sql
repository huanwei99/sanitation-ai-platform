-- 004_distribution_seed.sql — DR-T04 测试/示例库存种子
-- 与 foundation/engine.js 的物料清单一致,便于端到端对照。
-- 业务环境可删除本迁移;默认仓 DP-001(002 已建)。

INSERT OR IGNORE INTO inventory_item (id, name, spec, category, unit, stock, min_stock, location, unit_cost, is_rented, depot_id) VALUES
  ('INV-001', '一次性口罩', '10只/包', 'consumable', '包', 500, 200, 'A-01', 800, 0, 'DP-001'),
  ('INV-002', '84消毒液', '5L/瓶', 'consumable', '瓶', 120, 30, 'A-02', 1500, 0, 'DP-001'),
  ('INV-003', '扫帚', '标准', 'tool', '把', 80, 20, 'B-01', 1200, 0, 'DP-001'),
  ('INV-004', '手套', '20副/盒', 'consumable', '盒', 200, 50, 'A-03', 600, 0, 'DP-001'),
  ('INV-005', '工装服', 'L号', 'consumable', '件', 150, 40, 'C-01', 4500, 0, 'DP-001');