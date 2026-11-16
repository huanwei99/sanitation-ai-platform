// backup.js — SQLite 备份/恢复(P0-T05 补齐:夜间备份 + 可回滚验收)
//
// 用法(在 server/ 目录下):
//   node backup.js                    立即备份(WAL 先 checkpoint,再复制库文件 + 完整性校验)
//   node backup.js list               列出已有备份
//   node backup.js restore <名称>     从备份恢复(请先停服务!恢复后重启服务)
//
// 备份存于 server/data/backups/,默认保留最近 20 份,更旧的自动清理。
// 恢复是"覆盖式":当前库被直接替换,慎用(演练过,见 DEPLOYMENT.md §11)。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'warehouse.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 20;

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function walCheckpoint(dbPath) {
  // 把 WAL 落盘到主库,保证复制的 .db 文件是完整的
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function integrityOk(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    return row && row.integrity_check === 'ok';
  } finally {
    db.close();
  }
}

function doBackup() {
  if (!fs.existsSync(DB_PATH)) { console.error('[backup] 库不存在:', DB_PATH); process.exit(1); }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  walCheckpoint(DB_PATH);

  const name = `warehouse-${ts()}.db`;
  const dest = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DB_PATH, dest);

  if (!integrityOk(dest)) {
    fs.unlinkSync(dest);
    console.error('[backup] 备份完整性校验失败,已删除该备份');
    process.exit(1);
  }

  // 保留最近 KEEP 份
  const olds = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^warehouse-.*\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of olds) fs.unlinkSync(path.join(BACKUP_DIR, f));

  const sizeKb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`[backup] ✓ ${name} (${sizeKb} KB,integrity ok)`);
  console.log(`[backup] 存于 ${BACKUP_DIR}`);
}

function doList() {
  if (!fs.existsSync(BACKUP_DIR)) { console.log('[list] 暂无备份'); return; }
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^warehouse-.*\.db$/.test(f)).sort().reverse();
  if (files.length === 0) { console.log('[list] 暂无备份'); return; }
  console.log('[list] 现有备份(新→旧):');
  for (const f of files) {
    const ok = integrityOk(path.join(BACKUP_DIR, f));
    console.log(`  ${f}  ${ok ? '✓ 完整' : '✗ 损坏'}  ${(fs.statSync(path.join(BACKUP_DIR, f)).size / 1024).toFixed(1)} KB`);
  }
}

function doRestore(name) {
  if (!name) { console.error('[restore] 用法: node backup.js restore <备份名>'); process.exit(1); }
  const src = path.join(BACKUP_DIR, name.endsWith('.db') ? name : `${name}.db`);
  if (!fs.existsSync(src)) { console.error(`[restore] 备份不存在: ${src}`); console.error('[restore] 可用备份: node backup.js list'); process.exit(1); }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[restore] 当前库不存在(${DB_PATH}),无需恢复`);
    process.exit(1);
  }

  // 先复制到临时文件并校验,再替换 —— 避免恢复失败时原库也丢了
  const part = DB_PATH + '.part';
  fs.copyFileSync(src, part);
  if (!integrityOk(part)) {
    fs.unlinkSync(part);
    console.error(`[restore] ✗ 备份 ${name} 完整性校验失败,已中止(原库未动)`);
    process.exit(1);
  }

  let busy = false;
  try { fs.unlinkSync(DB_PATH); } catch (e) { busy = true; }
  if (busy) {
    fs.unlinkSync(part);
    console.error('[restore] ✗ 库文件被占用 —— 请先停服务(npm start 的窗口按 Ctrl+C),再重试');
    process.exit(1);
  }

  fs.renameSync(part, DB_PATH);
  for (const ext of ['-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  if (!integrityOk(DB_PATH)) { console.error('[restore] ✗ 恢复后完整性校验失败!请保留备份并排查'); process.exit(1); }
  console.log(`[restore] ✓ 已从 ${name} 恢复 ${DB_PATH}`);
  console.log('[restore] 现在可以重启服务: npm start');
}

// ---- CLI ----
const cmd = process.argv[2];
if (!cmd || cmd === 'backup') doBackup();
else if (cmd === 'list') doList();
else if (cmd === 'restore') doRestore(process.argv[3]);
else {
  console.log('用法: node backup.js [backup|list|restore <名称>]');
  process.exit(1);
}
