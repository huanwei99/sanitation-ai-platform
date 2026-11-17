-- 012_performance_config.sql — 子系统B 绩效完整模块(P2-T02):权重配置 + 申诉决议
-- 依赖:011_performance.sql(performance_record 基表)。
-- 设计:
--   ① performance_weight_config:岗位权重配置表,引擎 getWeightProfile 优先读此表,
--      种子与 performance.js WEIGHT_PROFILES 常量一致(单一事实源在配置表,常量作兜底)。
--   ② performance_record 增加申诉决议列:appeal_decision(待决/维持/撤销)、
--      appeal_note、appeal_decided_by、appeal_decided_at。申诉提交(status=appealed)后
--      由有权限主体裁决,裁决结果落此列,不改动既有状态机列。

PRAGMA foreign_keys = ON;

-- ============ 岗位权重配置表(可配置) ============

CREATE TABLE IF NOT EXISTS performance_weight_config (
  position      TEXT PRIMARY KEY,                  -- 岗位名(与 employees.position 对应)
  weights_json  TEXT NOT NULL,                     -- JSON: 维度权重,如 {"attendance":20,...}
  updated_by    TEXT,                              -- 最近修改人(工号/账号)
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 种子:5 岗位,与 performance.js WEIGHT_PROFILES 初始口径一致
INSERT OR IGNORE INTO performance_weight_config (position, weights_json) VALUES
  ('管理层',   '{"attendance":15,"quality":25,"task":30,"safety":15,"collaboration":15}'),
  ('司机',     '{"attendance":20,"quality":20,"task":30,"safety":25,"collaboration":5}'),
  ('保洁员',   '{"attendance":25,"quality":35,"task":25,"safety":10,"collaboration":5}'),
  ('班组长',   '{"attendance":20,"quality":25,"task":25,"safety":15,"collaboration":15}'),
  ('办公人员', '{"attendance":20,"quality":15,"task":30,"safety":10,"collaboration":25}');

-- ============ performance_record:申诉决议列 ============

ALTER TABLE performance_record ADD COLUMN appeal_decision TEXT
  CHECK(appeal_decision IN ('pending','upheld','overturned'));  -- 待决/维持/撤销
ALTER TABLE performance_record ADD COLUMN appeal_note TEXT;
ALTER TABLE performance_record ADD COLUMN appeal_decided_by TEXT;
ALTER TABLE performance_record ADD COLUMN appeal_decided_at TIMESTAMP;
