-- 010_rental_events.sql — P1-T03:扩展 chain_event.event 白名单,支持外租事件
-- 新增事件:rent_created(合同创建)/ rent_returned(归还)
-- 重建 chain_event 表 + 重建 005 的 append-only 触发器

DROP TRIGGER IF EXISTS trg_chain_event_no_update;
DROP TRIGGER IF EXISTS trg_chain_event_no_delete;

CREATE TABLE chain_event_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type        TEXT    NOT NULL,
  ref_id          TEXT    NOT NULL,
  step_no         INTEGER,
  event           TEXT    NOT NULL CHECK(event IN (
                    'approval_granted','step_started','step_completed',
                    'transfer','signoff','stock_deducted','cancel','edit_rejected',
                    'created','quality_passed','quality_failed',
                    'rent_created','rent_returned'
                  )),
  actor_id        INTEGER NOT NULL REFERENCES employees(employee_id),
  actor_role      TEXT,
  payload         TEXT    NOT NULL DEFAULT '{}',
  occurred_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  captured_at     TIMESTAMP,
  prev_event_hash TEXT,
  event_hash      TEXT    NOT NULL
);
INSERT INTO chain_event_new SELECT * FROM chain_event;
DROP TABLE chain_event;
ALTER TABLE chain_event_new RENAME TO chain_event;
CREATE INDEX IF NOT EXISTS idx_event_ref ON chain_event(ref_type, ref_id, id);

-- 重建 005 的 append-only 触发器
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
