-- 006_proxy_signoff.sql — 签收策略：self-only → 代签白名单
-- 背景：一线员工 50-65 岁，不假设每人会用智能手机，由班组长/车队长代录入签收。
-- 设计：signoff.self_only 关闭；新增 signoff.proxy_positions（逗号分隔岗位关键字）。
-- 签收人若在接收人池 → 本人签收；否则需 position 匹配白名单关键字，且必须指定 recipient_id。

-- 关闭 self-only 强制策略
UPDATE org_policy SET value = 'false' WHERE key = 'signoff.self_only';

-- 代签白名单岗位（contains 匹配，逗号分隔）
INSERT OR IGNORE INTO org_policy(key, value) VALUES
  ('signoff.proxy_positions', '班组长,车队长,队长');
