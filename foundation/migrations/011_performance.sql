-- 011_performance.sql — 子系统B 绩效评分:数据来源表 + 考核结果表
-- 为 P2-T01 评分引擎提供考勤/任务/质检/奖惩四类数据源,并落库存计算结果。
-- 设计依据:platform-upgrade-plan.md §十(权威定义)。
-- 日期字段用 TEXT(YYYY-MM-DD),与考核周期 period(YYYY-MM)的前缀匹配对齐。

PRAGMA foreign_keys = ON;

-- ============ 数据来源表(评分引擎输入) ============

-- 考勤记录(出勤维度数据源)
CREATE TABLE IF NOT EXISTS attendance_record (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(employee_id),
  date        TEXT    NOT NULL,                    -- YYYY-MM-DD
  status      TEXT    NOT NULL CHECK(status IN ('正常','迟到','缺勤','请假')),
  note        TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance_record(employee_id, date);

-- 任务分配(任务完成维度数据源)
CREATE TABLE IF NOT EXISTS task_assignment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(employee_id),
  title          TEXT    NOT NULL,
  due_date       TEXT    NOT NULL,                 -- YYYY-MM-DD 截止日期
  status         TEXT    NOT NULL CHECK(status IN ('进行中','已完成','已取消')),
  completed_date TEXT,                              -- YYYY-MM-DD 完成日期(按时判定)
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_emp_due ON task_assignment(employee_id, due_date);

-- 质检考核(作业质量维度数据源;区别于入库质检 inbound_record)
CREATE TABLE IF NOT EXISTS quality_check (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  INTEGER NOT NULL REFERENCES employees(employee_id),  -- 被考核人
  inspector_id INTEGER REFERENCES employees(employee_id),           -- 考核人
  date         TEXT    NOT NULL,                    -- YYYY-MM-DD
  score        INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),    -- 考核得分
  note         TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quality_emp_date ON quality_check(employee_id, date);

-- 奖惩记录(安全合规维度 + 协作维度数据源)
-- score 带符号:奖励为正、处罚为负,与安全维度加减分口径一致。
CREATE TABLE IF NOT EXISTS reward_penalty (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(employee_id),
  type        TEXT    NOT NULL CHECK(type IN ('reward','penalty')),
  score       INTEGER NOT NULL,                     -- 正=奖 负=罚
  reason      TEXT,
  date        TEXT    NOT NULL,                     -- YYYY-MM-DD
  approved_by INTEGER REFERENCES employees(employee_id),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rp_emp_date ON reward_penalty(employee_id, date);

-- ============ 考核结果表(评分引擎输出,可追溯) ============

CREATE TABLE IF NOT EXISTS performance_record (
  id           TEXT PRIMARY KEY,                   -- PR-2026-xxx
  employee_id  INTEGER NOT NULL REFERENCES employees(employee_id),
  period       TEXT    NOT NULL,                   -- YYYY-MM 考核月份
  period_type  TEXT    NOT NULL DEFAULT 'monthly', -- monthly/quarterly/yearly
  scores_json  TEXT    NOT NULL,                   -- JSON:各维度得分+明细
  weights_json TEXT    NOT NULL,                   -- JSON:实际使用权重
  total_score  REAL    NOT NULL,                   -- 加权总分
  grade        TEXT    NOT NULL,                   -- S/A/B/C/D
  status       TEXT    NOT NULL DEFAULT 'draft',   -- draft/confirmed/appealed
  comment      TEXT,
  comment_by   TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP,
  UNIQUE(employee_id, period, period_type)
);
CREATE INDEX IF NOT EXISTS idx_perf_emp_period ON performance_record(employee_id, period);
