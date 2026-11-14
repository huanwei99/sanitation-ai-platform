-- 003_auth_lockout.sql — DR-T03 认证增强字段
-- 支撑 SOP-Org-03:错密 5 次锁定 + 首登强制改密 + 管理员解锁。

-- 失败计数 / 锁定 / 首登改密标志
ALTER TABLE employees ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN locked_at        TIMESTAMP;
ALTER TABLE employees ADD COLUMN must_change_pwd  INTEGER NOT NULL DEFAULT 0;  -- 0=否 1=是(首登强制改密)

-- 管理员解锁/重置审计事件(追加不可改,与 chain_event 解耦)
CREATE TABLE IF NOT EXISTS account_lock_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(employee_id),
  event       TEXT    NOT NULL CHECK(event IN ('lock','unlock','password_reset')),
  actor_id    INTEGER,   -- NULL = 系统/服务端自动
  reason      TEXT,
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lock_log_emp ON account_lock_log(employee_id, occurred_at);