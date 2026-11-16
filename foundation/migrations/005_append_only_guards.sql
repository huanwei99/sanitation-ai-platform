-- 005_append_only_guards.sql — A2: append-only 在数据库层强制(此前仅为约定)
-- 目标:让 chain_event / stock_movement 真正「追加不可改」。应用层(app)不写 UPDATE/DELETE,
--      但此前数据库并未阻止;任何有 bug 或被攻陷的进程仍可重写「防篡改」审计轨迹。
-- 做法:SQLite 触发器,对 UPDATE / DELETE 抛错(raiserror 等价 RAISE(ABORT))。
--
-- 设计取舍(重要):
--   * stock_movement —— 无条件保护。全仓库无任何合法 UPDATE/DELETE 路径(已核 server/*.js)。
--   * chain_event   —— 默认保护,但**保留可显式拆除的逃生口**。原因:audit.test.js 的防篡改
--     用例(A-T10)需要真的 UPDATE 一行来证明哈希链能发现篡改。测试通过
--     DROP TRIGGER ... append_only 关掉护栏 → 篡改 → verifyChain=false → 重建触发器。
--     生产环境从不执行该 DROP,护栏常在。
--
-- 幂等:DROP TRIGGER IF EXISTS + CREATE TRIGGER(不 IF NOT EXISTS,保证可重放/可重建)。
-- 可平移 Postgres:Postgres 用 BEFORE UPDATE/DELETE ... RAISE EXCEPTION,语义一致。

-- ============ stock_movement:无条件追加不可改 ============
DROP TRIGGER IF EXISTS trg_stock_movement_no_update;
CREATE TRIGGER trg_stock_movement_no_update
BEFORE UPDATE ON stock_movement
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'stock_movement is append-only: UPDATE blocked (A2 guard)');
END;

DROP TRIGGER IF EXISTS trg_stock_movement_no_delete;
CREATE TRIGGER trg_stock_movement_no_delete
BEFORE DELETE ON stock_movement
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'stock_movement is append-only: DELETE blocked (A2 guard)');
END;

-- ============ chain_event:默认追加不可改(逃生口见文件头注释) ============
DROP TRIGGER IF EXISTS trg_chain_event_no_update;
CREATE TRIGGER trg_chain_event_no_update
BEFORE UPDATE ON chain_event
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'chain_event is append-only: UPDATE blocked (A2 guard)');
END;

DROP TRIGGER IF EXISTS trg_chain_event_no_delete;
CREATE TRIGGER trg_chain_event_no_delete
BEFORE DELETE ON chain_event
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'chain_event is append-only: DELETE blocked (A2 guard)');
END;