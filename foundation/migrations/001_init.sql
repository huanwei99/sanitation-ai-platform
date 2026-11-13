-- 001_init.sql — Phase-0 + 子系统A 建库脚本
-- 目标库：SQLite (WAL)；可平移到 Postgres（仅类型微调）
-- 编码：所有金额用「分」（整数），避免浮点误差；时间用 timestamptz
-- 外键主干：employee_id（沿用原型的 employeeId 中心模型）

PRAGMA foreign_keys = ON;

-- ============ Phase-0 基础 ============

-- 员工（沿用 employee_id 主键；权限三要素见 permissions 字段）
CREATE TABLE IF NOT EXISTS employees (
  employee_id   INTEGER PRIMARY KEY,          -- 工号（原型里 4/5/7/11/13…）
  name          TEXT    NOT NULL,
  position      TEXT,
  department    TEXT,
  team_id       INTEGER,
  project_id    INTEGER,
  region_id     INTEGER,
  account       TEXT    UNIQUE,               -- 登录账号（SOP-Org-03：EMP+3位工号）
  password_hash TEXT,                         -- bcrypt/argon2，替换 mock 登录
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 权限（沿用 platform-upgrade-plan 的三要素模型，服务端强制）
CREATE TABLE IF NOT EXISTS permissions (
  employee_id  INTEGER PRIMARY KEY REFERENCES employees(employee_id),
  mode         TEXT    NOT NULL DEFAULT 'auto',   -- auto=跟岗位模板 | manual=手动覆盖
  level        INTEGER NOT NULL,                  -- L1..L5
  scope        TEXT    NOT NULL,                  -- self|team|dept|project|region|group
  modules      TEXT    NOT NULL DEFAULT '{}',     -- JSON: {模块:[view,edit,export,admin]|'ALL'}
  admin_level  INTEGER NOT NULL DEFAULT 0,        -- 0=非管理员,1=项目,2=区域,3=总部
  granted_by   INTEGER REFERENCES employees(employee_id),
  granted_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 会话（替换 mock 登录；服务端持有）
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(employee_id),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at  TIMESTAMP NOT NULL
);

-- 幂等键（离线重放 / 重试安全的核心）
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  endpoint    TEXT    NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(employee_id),
  result_code INTEGER NOT NULL,                 -- 首次响应的状态码
  result_body TEXT,                             -- 首次响应体（重放原样返回）
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============ 子系统A：库管 / 物资发放 / 物料领取 ============

-- 库存主数据
CREATE TABLE IF NOT EXISTS inventory_item (
  id          TEXT PRIMARY KEY,                 -- INV-001（沿用原型编码）
  name        TEXT    NOT NULL,
  spec        TEXT,
  category    TEXT    NOT NULL CHECK(category IN ('consumable','tool','spare','office')),
  unit        TEXT    NOT NULL,
  stock       INTEGER NOT NULL CHECK(stock >= 0),
  min_stock   INTEGER NOT NULL,
  location    TEXT,
  unit_cost   INTEGER NOT NULL,                 -- 分
  is_rented   INTEGER NOT NULL DEFAULT 0,       -- 预留：外租台账
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 库存流水（唯一台账：所有库存增减都记一行，追加不可改）
CREATE TABLE IF NOT EXISTS stock_movement (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT    NOT NULL REFERENCES inventory_item(id),
  delta       INTEGER NOT NULL,                 -- +入 / -出
  reason      TEXT    NOT NULL CHECK(reason IN ('inbound','distribution_out','requisition_out','adjustment','return')),
  ref_type    TEXT    NOT NULL CHECK(ref_type IN ('inbound','distribution','requisition')),
  ref_id      TEXT    NOT NULL,                 -- IN-/MD-/MR- 单号
  line_no     INTEGER NOT NULL,                 -- 单据内的行号
  qty_after   INTEGER NOT NULL,                 -- 变动后余额（冗余，供审计）
  actor_id    INTEGER NOT NULL REFERENCES employees(employee_id),
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_movement_item ON stock_movement(item_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_movement_ref  ON stock_movement(ref_type, ref_id);

-- 入库单 + 行
CREATE TABLE IF NOT EXISTS inbound_record (
  id                  TEXT PRIMARY KEY,         -- IN-2026-xxx
  date                TEXT    NOT NULL,
  type                TEXT    NOT NULL,         -- 采购入库
  supplier            TEXT,
  total_cost          INTEGER NOT NULL,         -- 分
  operator_id         INTEGER NOT NULL REFERENCES employees(employee_id),
  status              TEXT    NOT NULL CHECK(status IN ('待质检','已完成')),
  approval_id         TEXT,
  quality_inspector_id INTEGER REFERENCES employees(employee_id),
  quality_result      TEXT CHECK(quality_result IN ('合格','不合格','待检')),
  quality_note        TEXT,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inbound_line (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inbound_id    TEXT    NOT NULL REFERENCES inbound_record(id),
  line_no       INTEGER NOT NULL,
  item_id       TEXT    NOT NULL REFERENCES inventory_item(id),
  qty           INTEGER NOT NULL CHECK(qty > 0),
  unit_cost     INTEGER NOT NULL                -- 分
);

-- 发放单（发放）
CREATE TABLE IF NOT EXISTS distribution (
  id             TEXT PRIMARY KEY,              -- MD-2026-xxx
  applicant_id   INTEGER NOT NULL REFERENCES employees(employee_id),
  department     TEXT,
  requested_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  scope          TEXT    NOT NULL CHECK(scope IN ('all','dept','units')),
  scope_desc     TEXT,
  total_people   INTEGER NOT NULL,
  total_cost     INTEGER NOT NULL,              -- 分
  distributor_id INTEGER NOT NULL REFERENCES employees(employee_id),  -- 发放人
  approval_id    TEXT,                          -- 见 G3：默认策略下 NOT NULL（审批前置）
  status         TEXT    NOT NULL CHECK(status IN ('待审批','已批准','发放中','已完成','已取消')),
  current_step   INTEGER NOT NULL DEFAULT 0,
  total_steps    INTEGER NOT NULL DEFAULT 4,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS distribution_line (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id TEXT   NOT NULL REFERENCES distribution(id),
  line_no        INTEGER NOT NULL,
  item_id        TEXT    NOT NULL REFERENCES inventory_item(id),
  per_person_qty INTEGER NOT NULL CHECK(per_person_qty > 0),
  qty            INTEGER NOT NULL CHECK(qty > 0)   -- = per_person_qty * total_people
);

-- 发放接收人（班组长去重后的接收池）
CREATE TABLE IF NOT EXISTS distribution_recipient (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distribution_id TEXT    NOT NULL REFERENCES distribution(id),
  employee_id     INTEGER NOT NULL REFERENCES employees(employee_id),
  units           TEXT,                         -- 覆盖单位（逗号分隔，原型语义）
  people_count    INTEGER,
  allocated_items TEXT,                         -- 分配物资（人读摘要，沿用原型）
  status          TEXT    NOT NULL CHECK(status IN ('待接收','已移交','已接收')),
  transferred_at  TIMESTAMP,
  received_at     TIMESTAMP,
  UNIQUE(distribution_id, employee_id)
);

-- 领取单（物料领取，2步）
CREATE TABLE IF NOT EXISTS requisition (
  id            TEXT PRIMARY KEY,               -- MR-2026-xxx
  applicant_id  INTEGER NOT NULL REFERENCES employees(employee_id),
  department    TEXT,
  requested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  urgency       TEXT    NOT NULL CHECK(urgency IN ('一般-日常补充','较急-3日内需要','紧急-当日需要')),
  req_type      TEXT,
  reason        TEXT,
  approver_id   INTEGER REFERENCES employees(employee_id),
  approval_id   TEXT,
  status        TEXT    NOT NULL CHECK(status IN ('审批中','已批准','发放中','已完成','已驳回')),
  current_step  INTEGER NOT NULL DEFAULT 0,
  total_steps   INTEGER NOT NULL DEFAULT 2,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS requisition_line (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id TEXT  NOT NULL REFERENCES requisition(id),
  line_no      INTEGER NOT NULL,
  item_id      TEXT    NOT NULL REFERENCES inventory_item(id),
  qty          INTEGER NOT NULL CHECK(qty > 0)
);

-- 通用流程步骤（发放4步 / 领取2步共用）
CREATE TABLE IF NOT EXISTS workflow_step (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type     TEXT    NOT NULL CHECK(ref_type IN ('distribution','requisition')),
  ref_id       TEXT    NOT NULL,
  step_no      INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  assignee_id  INTEGER REFERENCES employees(employee_id),
  status       TEXT    NOT NULL CHECK(status IN ('待执行','进行中','已完成')),
  started_at   TIMESTAMP,
  completed_at TIMESTAMP,
  note         TEXT,
  UNIQUE(ref_type, ref_id, step_no)
);

-- 链式审计事件（追加不可改，哈希串联防篡改）
CREATE TABLE IF NOT EXISTS chain_event (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type        TEXT    NOT NULL,
  ref_id          TEXT    NOT NULL,
  step_no         INTEGER,
  event           TEXT    NOT NULL CHECK(event IN ('approval_granted','step_started','step_completed','transfer','signoff','stock_deducted','cancel','edit_rejected')),
  actor_id        INTEGER NOT NULL REFERENCES employees(employee_id),
  actor_role      TEXT,
  payload         TEXT    NOT NULL DEFAULT '{}',   -- JSON
  occurred_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  captured_at     TIMESTAMP,                       -- 离线采集时间（客户端时钟）
  prev_event_hash TEXT,
  event_hash      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_ref ON chain_event(ref_type, ref_id, id);

-- 默认策略开关（审批是否前置等，避免硬编码）
CREATE TABLE IF NOT EXISTS org_policy (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO org_policy(key, value) VALUES
  ('distribution.require_approval', 'true'),
  ('requisition.require_approval',  'true'),
  ('signoff.self_only',             'true');
