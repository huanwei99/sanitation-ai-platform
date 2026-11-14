// seed-drill.js — DR-T08 演练种子:灌入演练角色账号(幂等,可重复执行)
// 用法: cd server && node seed-drill.js
// 作用: 在 server/data/warehouse.db 中 upsert 4 个演练账号 + 确认库存/仓库种子已就位。
// 库存/仓库种子由迁移 002/004 提供,本脚本只负责人员账号。

const { initDb, sqliteBackend } = require('./db');
const { seedAccount } = require('./auth');
const path = require('node:path');

const PWD = 'Aa@123456';   // 演练用统一初始密码(SOP-Org-03 默认);正式使用须首登改密

async function main() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'warehouse.db');
  const { db } = initDb(dbPath);
  console.log(`[seed] db=${dbPath} backend=${sqliteBackend()}`);

  // 演练角色
  await seedAccount(db, {
    employee_id: 9001, account: 'DRILL-KEEPER', password: PWD, name: '演练-库管员',
    position: '仓库管理员', department: '仓储部',
    permissions: { mode: 'manual', level: 3, scope: 'self',
      modules: { distribution: ['edit'], inventory: ['edit'] }, admin_level: 0 }
  });
  await seedAccount(db, {
    employee_id: 9002, account: 'DRILL-APPROVER', password: PWD, name: '演练-审批人',
    position: '项目主管', department: '管理部',
    permissions: { mode: 'manual', level: 4, scope: 'project',
      modules: { distribution: ['edit'] }, admin_level: 1 }
  });
  await seedAccount(db, {
    employee_id: 9003, account: 'DRILL-LEADER', password: PWD, name: '演练-班组长',
    position: '班组长', department: '一线作业', permissions: null
  });
  await seedAccount(db, {
    employee_id: 9004, account: 'DRILL-WORKER', password: PWD, name: '演练-一线员工',
    position: '保洁员', department: '一线作业', permissions: null
  });

  // 打印库存种子(便于演练前核对)
  const items = db.prepare('SELECT id, name, stock, min_stock FROM inventory_item ORDER BY id').all();
  console.log('[seed] 库存种子:');
  for (const it of items) {
    console.log(`  ${it.id}  ${it.name}  stock=${it.stock}  min=${it.min_stock}`);
  }
  console.log('\n[seed] 演练账号已就位(初始密码统一 ' + PWD + '):');
  console.log('  DRILL-KEEPER   演练-库管员   (创建/出库/移交)');
  console.log('  DRILL-APPROVER 演练-审批人   (审批)');
  console.log('  DRILL-LEADER   演练-班组长   (移动签收)');
  console.log('  DRILL-WORKER   演练-一线员工 (备用接收人)');
  console.log('\n[seed] 完成。');

  try { db.close(); } catch {}
}

main().catch(e => { console.error('[seed] 失败:', e); process.exit(1); });
