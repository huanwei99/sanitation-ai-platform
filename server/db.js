// DR-T02 — 数据层:SQLite(WAL)+ 迁移执行器
// 原样跑 foundation/migrations/001_init.sql + 002_multi_depot.sql。
// 验收:空库执行两份迁移无错;重启服务数据保留(A-T12 SQL 版)。
//
// 后端选择(规避 better-sqlite3 的原生编译问题):
//   1) 优先 node:sqlite   —— Node 22.5+ 内置,零依赖、零编译(推荐)
//   2) 回退 better-sqlite3 —— 需 npm install,可能触发原生编译(需 VS Build Tools)
// 两者 API 有差异,这里统一适配为相同的 openDb/prepare/transaction/exec 形态。

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'foundation', 'migrations');
// 自动发现 migrations/ 目录下所有编号升序的 .sql 迁移文件(单一事实源)
function discoverMigrations(migrationsDir = MIGRATIONS_DIR) {
  return fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

// ---- 后端探测 ----
function hasNodeSqlite() {
  try { require('node:sqlite'); return true; } catch { return false; }
}
function hasBetterSqlite3() {
  try { require.resolve('better-sqlite3'); return true; } catch { return false; }
}
function sqliteBackend() {
  if (hasNodeSqlite()) return 'node:sqlite';
  if (hasBetterSqlite3()) return 'better-sqlite3';
  return null;
}

// 打开原生连接(返回带统一方法的对象)
function openDb(dbPath) {
  const backend = sqliteBackend();
  if (backend === 'node:sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const conn = new DatabaseSync(dbPath);
    return wrapNodeSqlite(conn);
  }
  if (backend === 'better-sqlite3') {
    const Database = require('better-sqlite3');
    const conn = new Database(dbPath);
    return wrapBetterSqlite(conn);
  }
  throw new Error(
    '[db] 未找到可用的 SQLite 后端。请升级到 Node 22.5+(内置 node:sqlite),' +
    '或运行 `cd server && npm install` 安装 better-sqlite3。'
  );
}

// node:sqlite 适配:DatabaseSync 无 .pragma() 方法,用 exec 设 PRAGMA、
// prepare('PRAGMA x').get() 查询;exec 原生支持多语句。
function wrapNodeSqlite(conn) {
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  return {
    backend: 'node:sqlite',
    raw: conn,
    exec: sql => conn.exec(sql),
    prepare: sql => conn.prepare(sql),
    // p 形如 'user_version' 或 'user_version = 2':含 '=' 视为设置,否则查询
    pragma: (p) => {
      if (/\s*=\s*/.test(p)) return conn.exec(`PRAGMA ${p}`);
      return conn.prepare(`PRAGMA ${p}`).get();
    },
    transaction: fn => (...args) => { conn.exec('BEGIN'); try { const r = fn(...args); conn.exec('COMMIT'); return r; } catch (e) { conn.exec('ROLLBACK'); throw e; } },
    close: () => conn.close()
  };
}

// better-sqlite3 适配:native transaction,exec 原生支持多语句
function wrapBetterSqlite(conn) {
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  return {
    backend: 'better-sqlite3',
    raw: conn,
    exec: sql => conn.exec(sql),
    prepare: sql => conn.prepare(sql),
    pragma: (p, opts) => conn.pragma(p, opts),
    transaction: fn => conn.transaction(fn),
    close: () => conn.close()
  };
}

// 跨后端取标量 pragma:user_version 在 better-sqlite3 返回标量,
// 在 node:sqlite 返回 [{user_version:N}];统一成 number。
function getPragmaNumber(db, name) {
  const v = db.pragma(name);
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    return first[name] ?? Object.values(first)[0];
  }
  if (v && typeof v === 'object') return v[name] ?? Object.values(v)[0];
  return Number(v) || 0;
}

// 迁移执行器:幂等 —— 用 user_version 记录已应用到的编号,
// 重启/重复调用只补跑未应用的迁移(001+002 都是 IF NOT EXISTS,本身可重放)。
function runMigrations(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  let applied = getPragmaNumber(db, 'user_version');
  const results = [];
  const files = discoverMigrations(migrationsDir);

  for (const file of files) {
    const num = parseInt(file.split('_')[0], 10);
    if (num <= applied) {
      results.push({ file, skipped: true });
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // exec 支持多语句;事务包裹保证原子性
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${num}`);
    })();
    applied = num;
    results.push({ file, skipped: false });
  }
  return results;
}

// 初始化一个可直接用的 db(打开 + 迁移)。
// dbPath 默认落在 server/data/warehouse.db;传 ':memory:' 供测试。
function initDb(dbPath, opts = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = openDb(dbPath);
  const migrations = runMigrations(db, opts);
  return { db, migrations };
}

module.exports = { openDb, runMigrations, initDb, getPragmaNumber, sqliteBackend, discoverMigrations, MIGRATIONS_DIR };
