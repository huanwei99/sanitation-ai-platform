-- 013_emergency.sql — P2-T03 清雪应急指挥调度(子系统B)
-- 需求:五阶段状态机 + 战报引擎;外租+自有设备混合调度。
-- 权威定义:PROJECT-SOLUTION-DOC.md §3.9、platform-upgrade-plan.md §九。
--
-- 内容:
--   1. 重建 chain_event —— 扩 event CHECK 约束,新增应急事件类型(保留既有数据与哈希链)
--   2. emergency_plan      应急预案模板(可配置)
--   3. emergency_event     应急事件实例(五阶段状态机)
--   4. emergency_dispatch  调度任务(自有/外租/人员混合调度,三可空外键替代多态)
--   5. emergency_progress_log 进度日志
--   6. emergency_battle_report 战报(content Markdown + data_json 结构化)
--   7. 种子:plan_snow / plan_flood 两个预案模板

-- ============ 1. 重建 chain_event(扩 event CHECK)============
-- append-only 触发器只拦 UPDATE/DELETE,不拦 INSERT,故可先 DROP 触发器 → 重建表 →
-- INSERT ... SELECT 拷数据 → DROP 旧表 → RENAME → 重建同名触发器。
-- 全程由 db.js runMigrations 的 db.transaction() 包裹,保证原子。

DROP TRIGGER IF EXISTS trg_chain_event_no_update;
DROP TRIGGER IF EXISTS trg_chain_event_no_delete;

CREATE TABLE chain_event_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type        TEXT    NOT NULL,
  ref_id          TEXT    NOT NULL,
  step_no         INTEGER,
  event           TEXT    NOT NULL CHECK(event IN (
                    -- 001_init 基础事件
                    'approval_granted','step_started','step_completed','transfer',
                    'signoff','stock_deducted','cancel','edit_rejected',
                    -- 008 入库质检事件(P1-T02)
                    'created','quality_passed','quality_failed',
                    -- 010 外租事件(P1-T03)
                    'rent_created','rent_returned',
                    -- 013 应急事件(P2-T03)
                    'event_created','event_verified','event_activated','event_start_executing',
                    'event_resolved','event_cancelled','dispatch','progress_report','battle_report'
                  )),
  actor_id        INTEGER NOT NULL REFERENCES employees(employee_id),
  actor_role      TEXT,
  payload         TEXT    NOT NULL DEFAULT '{}',   -- JSON
  occurred_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  captured_at     TIMESTAMP,                       -- 离线采集时间(客户端时钟)
  prev_event_hash TEXT,
  event_hash      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_ref ON chain_event_new(ref_type, ref_id, id);

-- 拷贝既有数据(保留 id/prev_event_hash/event_hash,哈希链不断裂)
INSERT INTO chain_event_new (id, ref_type, ref_id, step_no, event, actor_id, actor_role,
                             payload, occurred_at, captured_at, prev_event_hash, event_hash)
SELECT id, ref_type, ref_id, step_no, event, actor_id, actor_role,
       payload, occurred_at, captured_at, prev_event_hash, event_hash
  FROM chain_event;

DROP TABLE chain_event;
ALTER TABLE chain_event_new RENAME TO chain_event;

-- 重建同名 append-only 触发器(与 005 完全一致)
CREATE TRIGGER trg_chain_event_no_update
BEFORE UPDATE ON chain_event
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'chain_event is append-only: UPDATE blocked (A2 guard)');
END;

CREATE TRIGGER trg_chain_event_no_delete
BEFORE DELETE ON chain_event
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'chain_event is append-only: DELETE blocked (A2 guard)');
END;

-- ============ 2. 应急预案模板 ============
CREATE TABLE IF NOT EXISTS emergency_plan (
  id                  TEXT PRIMARY KEY,                -- EP-SNOW / EP-FLOOD
  name                TEXT NOT NULL,
  category            TEXT NOT NULL CHECK(category IN ('snow','flood','fire','accident')),
  icon                TEXT,
  trigger_conditions  TEXT NOT NULL DEFAULT '{}',      -- JSON:触发条件
  levels              TEXT NOT NULL DEFAULT '[]',      -- JSON:[{code,name,threshold}]
  resources           TEXT NOT NULL DEFAULT '[]',      -- JSON:默认调度资源
  procedures          TEXT NOT NULL DEFAULT '[]',      -- JSON:处置步骤
  created_by          INTEGER REFERENCES employees(employee_id),
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============ 3. 应急事件实例(五阶段状态机)============
CREATE TABLE IF NOT EXISTS emergency_event (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id            TEXT NOT NULL REFERENCES emergency_plan(id),
  title               TEXT NOT NULL,
  category            TEXT NOT NULL CHECK(category IN ('snow','flood','fire','accident')),
  level               TEXT NOT NULL CHECK(level IN ('I','II','III')),
  status              TEXT NOT NULL CHECK(status IN ('alert','verified','activated','executing','resolved','cancelled')) DEFAULT 'alert',
  start_time          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_time            TIMESTAMP,                      -- 结案/取消时写
  commander_id        INTEGER REFERENCES employees(employee_id),
  deputy_commander_id INTEGER REFERENCES employees(employee_id),
  situation           TEXT NOT NULL DEFAULT '{}',      -- JSON:实时态势(路段/影响/天气等)
  summary             TEXT NOT NULL DEFAULT '{}',      -- JSON:结案复盘摘要
  created_by          INTEGER NOT NULL REFERENCES employees(employee_id),
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emergency_event_status ON emergency_event(status);
CREATE INDEX IF NOT EXISTS idx_emergency_event_category ON emergency_event(category, level);

-- ============ 4. 调度任务(外租+自有设备混合调度)============
-- source=own   → inventory_item_id 指向自有物资
-- source=rented → rental_item_id   指向在租设备
-- resource_type=personnel → employee_id 指向人员
-- 调度是「分配」动作:不改 inventory_item.stock / rental_item.status,避免与库管/外租台账重复记账。
CREATE TABLE IF NOT EXISTS emergency_dispatch (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER NOT NULL REFERENCES emergency_event(id),
  resource_type     TEXT NOT NULL CHECK(resource_type IN ('personnel','vehicle','material')),
  source            TEXT NOT NULL CHECK(source IN ('own','rented')),
  inventory_item_id TEXT,                            -- 自有物资(inventory_item 主键为复合键(id,depot_id),此处不设外键,存在性由领域层校验)
  rental_item_id    INTEGER REFERENCES rental_item(id),     -- 外租设备
  employee_id       INTEGER REFERENCES employees(employee_id),  -- 人员
  resource_name     TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('assigned','in_progress','completed','released')) DEFAULT 'assigned',
  assigned_role     TEXT,
  area              TEXT,                                -- 责任路段/区域
  note              TEXT,
  dispatched_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  released_at       TIMESTAMP,
  created_by        INTEGER NOT NULL REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_emergency_dispatch_event ON emergency_dispatch(event_id);
CREATE INDEX IF NOT EXISTS idx_emergency_dispatch_status ON emergency_dispatch(event_id, status);

-- ============ 5. 进度日志 ============
CREATE TABLE IF NOT EXISTS emergency_progress_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES emergency_event(id),
  action     TEXT NOT NULL,
  actor_id   INTEGER REFERENCES employees(employee_id),
  detail     TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emergency_progress_event ON emergency_progress_log(event_id, id);

-- ============ 6. 战报(content Markdown + data_json 结构化)============
CREATE TABLE IF NOT EXISTS emergency_battle_report (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL UNIQUE REFERENCES emergency_event(id),
  content       TEXT NOT NULL,                      -- Markdown,供展示/打印
  data_json     TEXT NOT NULL DEFAULT '{}',        -- 结构化,供机器消费与确定性测试
  format        TEXT NOT NULL DEFAULT 'markdown',
  generated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  generated_by  INTEGER REFERENCES employees(employee_id)
);

-- ============ 7. 种子:应急预案模板 ============
-- 种子 created_by 留空(NULL):员工由 seed-drill.js 灌入,迁移阶段无员工可引用。
INSERT INTO emergency_plan (id, name, category, icon, trigger_conditions, levels, resources, procedures)
VALUES
(
  'EP-SNOW', '暴雪清雪预案', 'snow', '❄',
  '{"condition":"24小时降雪量≥10mm 或 气象台发布暴雪蓝色及以上预警","auto_activate":false}',
  '[{"code":"III","name":"小雪","threshold":"降雪量<5mm"},{"code":"II","name":"中雪","threshold":"降雪量5-10mm"},{"code":"I","name":"大雪","threshold":"降雪量≥10mm 或 暴雪预警"}]',
  '[{"resource_type":"vehicle","source":"own","name":"扫雪车","default_qty":4},{"resource_type":"vehicle","source":"rented","name":"装载机","default_qty":2},{"resource_type":"material","source":"own","name":"融雪剂","default_qty":500},{"resource_type":"personnel","source":"own","name":"保洁员","default_qty":30}]',
  '[{"step":1,"action":"核实","desc":"确认降雪范围与等级,核实路段影响"},{"step":2,"action":"启动预案","desc":"按等级调度扫雪车/装载机/融雪剂/人员"},{"step":3,"action":"执行跟踪","desc":"按路段推进清雪,记录进度"},{"step":4,"action":"结案复盘","desc":"清理完毕,生成战报"}]'
),
(
  'EP-FLOOD', '暴雨内涝预案', 'flood', '⛈',
  '{"condition":"24小时降雨量≥50mm 或 气象台发布暴雨橙色及以上预警","auto_activate":false}',
  '[{"code":"III","name":"小到中雨","threshold":"降雨量<25mm"},{"code":"II","name":"大雨","threshold":"降雨量25-50mm"},{"code":"I","name":"暴雨","threshold":"降雨量≥50mm 或 暴雨预警"}]',
  '[{"resource_type":"vehicle","source":"own","name":"抽水车","default_qty":2},{"resource_type":"vehicle","source":"rented","name":"应急排水车","default_qty":2},{"resource_type":"material","source":"own","name":"沙袋","default_qty":200},{"resource_type":"personnel","source":"own","name":"一线作业人员","default_qty":20}]',
  '[{"step":1,"action":"核实","desc":"确认积水范围与等级,核实路段影响"},{"step":2,"action":"启动预案","desc":"按等级调度抽水车/排水车/沙袋/人员"},{"step":3,"action":"执行跟踪","desc":"按路段推进排水,记录进度"},{"step":4,"action":"结案复盘","desc":"积水退去,生成战报"}]'
)
ON CONFLICT(id) DO NOTHING;
