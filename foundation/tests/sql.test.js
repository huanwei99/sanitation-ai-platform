// sql.test.js — SQL 版验收测试(DR-T07 交付物)
// 用真实 SQLite(node:sqlite,零依赖)跑迁移 001+002,把关键验收项落到真实 SQL 事务上。
// 这份脚本同时是 DR-T04(发放链 API)/DR-T06(审计链)的 SQL 参考实现:
//   开发者照这里的 deduct / withTx / recordEvent / verifyChain 搬进服务端即可。
// 运行:node --test tests/sql.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MIG = (f) => path.join(__dirname, '..', 'migrations', f);

class SqlError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ---------- 库初始化:跑迁移 + 种子 ----------
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(MIG('001_init.sql'), 'utf8'));
  db.exec(fs.readFileSync(MIG('002_multi_depot.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON;');
  seed(db);
  return db;
}

function seed(db) {
  const emp = db.prepare('INSERT INTO employees(employee_id,name,position,department) VALUES(?,?,?,?)');
  for (const [id, name, pos, dept] of [
    [4, '刘洋', '项目经理', '综合管理部'], [5, '陈静', '仓库负责人', '综合管理部'],
    [7, '孙磊', '车队长', '机械作业部'], [11, '马丽', '片区经理', '人工作业部'],
    [13, '林小红', '班组长', '人工作业部'], [16, '胡明', '机动保洁队长', '人工作业部'],
  ]) emp.run(id, name, pos, dept);

  const inv = db.prepare('INSERT INTO inventory_item(id,name,spec,category,unit,stock,min_stock,unit_cost,depot_id) VALUES(?,?,?,?,?,?,?,?,?)');
  inv.run('INV-001', '保洁手套', '乳胶加厚', 'consumable', '双', 500, 100, 250, 'DP-001');
  inv.run('INV-004', '工作服', '秋冬款带反光条', 'consumable', '套', 15, 20, 8500, 'DP-001');
  inv.run('INV-006', '机油', '15W-40 柴机油', 'consumable', '桶', 10, 5, 18000, 'DP-001');
  inv.run('INV-201', '保洁手套', '乳胶加厚', 'consumable', '双', 5, 10, 250, 'DP-002'); // 二仓同款,隔离用
}

// ---------- 事务包装 ----------
function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- 策略 ----------
const policy = (db, k) => db.prepare('SELECT value FROM org_policy WHERE key=?').get(k)?.value;

// ---------- 审计链(哈希串联,防篡改) ----------
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
function recordEvent(db, { ref_type, ref_id, step_no = null, event, actor_id, actor_role = null, payload = {} }) {
  const occurred_at = new Date().toISOString();
  const prev = db.prepare('SELECT event_hash FROM chain_event WHERE ref_type=? AND ref_id=? ORDER BY id DESC LIMIT 1')
    .get(ref_type, ref_id)?.event_hash || '';
  const event_hash = sha({ ref_type, ref_id, step_no, event, actor_id, actor_role, payload: JSON.stringify(payload), occurred_at, prev });
  db.prepare(`INSERT INTO chain_event(ref_type,ref_id,step_no,event,actor_id,actor_role,payload,occurred_at,prev_event_hash,event_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(ref_type, ref_id, step_no, event, actor_id, actor_role, JSON.stringify(payload), occurred_at, prev, event_hash);
}
function verifyChain(db, ref_type, ref_id) {
  const rows = db.prepare('SELECT * FROM chain_event WHERE ref_type=? AND ref_id=? ORDER BY id').all(ref_type, ref_id);
  let prev = '';
  for (const ev of rows) {
    if (ev.prev_event_hash !== prev) return false;
    const expect = sha({ ref_type: ev.ref_type, ref_id: ev.ref_id, step_no: ev.step_no, event: ev.event, actor_id: ev.actor_id, actor_role: ev.actor_role, payload: ev.payload, occurred_at: ev.occurred_at, prev });
    if (expect !== ev.event_hash) return false;
    prev = ev.event_hash;
  }
  return true;
}

// ---------- 库存台账(唯一写入口;调用方负责事务) ----------
function deductOnce(db, { item_id, qty, reason, ref_type, ref_id, line_no, actor_id }) {
  const item = db.prepare('SELECT * FROM inventory_item WHERE id=?').get(item_id);
  if (!item) throw new SqlError('NOT_FOUND', `库存不存在: ${item_id}`);
  if (item.stock < qty) throw new SqlError('STOCK_SHORTFALL', `库存不足（仓 ${item.depot_id}）: ${item_id} 可用=${item.stock} 需求=${qty}`);
  const newStock = item.stock - qty;
  db.prepare('UPDATE inventory_item SET stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newStock, item_id);
  db.prepare(`INSERT INTO stock_movement(item_id,depot_id,delta,reason,ref_type,ref_id,line_no,qty_after,actor_id)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(item_id, item.depot_id, -qty, reason, ref_type, ref_id, line_no, newStock, actor_id);
  return { item_id, depot_id: item.depot_id, qty_after: newStock };
}

// ---------- 幂等 ----------
function withIdem(db, key, actorId, fn) {
  if (!key) return fn();
  const hit = db.prepare('SELECT result_body FROM idempotency_keys WHERE key=?').get(key);
  if (hit) return JSON.parse(hit.result_body);
  const result = fn();
  db.prepare('INSERT INTO idempotency_keys(key,endpoint,employee_id,result_code,result_body) VALUES(?,?,?,?,?)')
    .run(key, 'test', actorId, 200, JSON.stringify(result ?? {}));
  return result;
}

// ---------- 发放(4步) ----------
function createDistribution(db, { applicant_id, department, scope, scope_desc, total_people, distributor_id, lines, approval_id = null, depot_id }) {
  if (!depot_id) throw new SqlError('DEPOT_REQUIRED', '发放必须指定出库仓库');
  if (!db.prepare('SELECT 1 FROM depot WHERE id=?').get(depot_id)) throw new SqlError('NOT_FOUND', `仓库不存在: ${depot_id}`);
  for (const l of lines) {
    const it = db.prepare('SELECT depot_id FROM inventory_item WHERE id=?').get(l.item_id);
    if (!it) throw new SqlError('NOT_FOUND', `库存不存在: ${l.item_id}`);
    if (it.depot_id !== depot_id) throw new SqlError('DEPOT_MISMATCH', `物资 ${l.item_id} 属于仓 ${it.depot_id}，不能从 ${depot_id} 出库`);
  }
  return withTx(db, () => {
    const id = nextId(db, 'MD');
    // 总额 = Σ(qty × 库存单价)，分
    let totalCost = 0;
    const unitCost = db.prepare('SELECT unit_cost FROM inventory_item WHERE id=?');
    for (const l of lines) {
      const qty = l.per_person_qty * total_people;
      totalCost += qty * unitCost.get(l.item_id).unit_cost;
    }
    db.prepare(`INSERT INTO distribution(id,applicant_id,department,scope,scope_desc,total_people,total_cost,distributor_id,approval_id,depot_id,status,current_step,total_steps)
      VALUES(?,?,?,?,?,?,?,?,?,?,'待审批',0,4)`)
      .run(id, applicant_id, department, scope, scope_desc, total_people, totalCost, distributor_id, approval_id, depot_id);
    const line = db.prepare('INSERT INTO distribution_line(distribution_id,line_no,item_id,per_person_qty,qty) VALUES(?,?,?,?,?)');
    lines.forEach((l, i) => line.run(id, i + 1, l.item_id, l.per_person_qty, l.per_person_qty * total_people));
    return id;
  });
}

function approveDistribution(db, { dist_id, actor_id, approval_completed = true }) {
  const d = mustDist(db, dist_id);
  if (d.status !== '待审批') throw new SqlError('INVALID_STATE', `当前状态 ${d.status}`);
  if (policy(db, 'distribution.require_approval') === 'true' && (!d.approval_id || !approval_completed)) {
    throw new SqlError('APPROVAL_MISSING', '缺少已完成审批(G3)');
  }
  return withTx(db, () => {
    db.prepare("UPDATE distribution SET status='已批准', current_step=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(dist_id);
    const step = db.prepare('INSERT INTO workflow_step(ref_type,ref_id,step_no,name,assignee_id,status) VALUES(?,?,?,?,?,?)');
    const steps = [[1, '仓库出库', 5], [2, '发放人接收', d.distributor_id], [3, '发放人移交', d.distributor_id], [4, '接收人接收', null]];
    for (const [no, name, asg] of steps) step.run('distribution', dist_id, no, name, asg, no === 1 ? '进行中' : '待执行');
    recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, event: 'approval_granted', actor_id });
    return true;
  });
}

function completeStep(db, { dist_id, step_no, actor_id, idempotency_key = null }) {
  return withIdem(db, idempotency_key, actor_id, () => withTx(db, () => {
    const d = mustDist(db, dist_id);
    if (d.current_step !== step_no) throw new SqlError('CONFLICT', `步骤冲突:期望 ${d.current_step}`);
    if (step_no === 1) {
      const lines = db.prepare('SELECT * FROM distribution_line WHERE distribution_id=? ORDER BY line_no').all(dist_id);
      for (const l of lines) { // 先全部校验(G2),再统一扣减(同一事务)
        const it = db.prepare('SELECT depot_id,stock FROM inventory_item WHERE id=?').get(l.item_id);
        if (it.depot_id !== d.depot_id) throw new SqlError('DEPOT_MISMATCH', `物资 ${l.item_id} 不在出库仓 ${d.depot_id}`);
        if (it.stock < l.qty) throw new SqlError('STOCK_SHORTFALL', `库存不足（仓 ${d.depot_id}）: ${l.item_id} 可用=${it.stock} 需求=${l.qty}`);
      }
      for (const l of lines) {
        const mv = deductOnce(db, { item_id: l.item_id, qty: l.qty, reason: 'distribution_out', ref_type: 'distribution', ref_id: dist_id, line_no: l.line_no, actor_id });
        recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 1, event: 'stock_deducted', actor_id, payload: { item_id: l.item_id, qty: l.qty, qty_after: mv.qty_after } });
      }
    }
    db.prepare('UPDATE workflow_step SET status=?,completed_at=CURRENT_TIMESTAMP WHERE ref_type=? AND ref_id=? AND step_no=?').run('已完成', 'distribution', dist_id, step_no);
    const next = step_no + 1;
    db.prepare('UPDATE distribution SET current_step=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(next, step_no === 1 ? '发放中' : d.status, dist_id);
    if (next <= 4) db.prepare('UPDATE workflow_step SET status=? WHERE ref_type=? AND ref_id=? AND step_no=?').run('进行中', 'distribution', dist_id, next);
    recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no, event: 'step_completed', actor_id });
    return { ok: true };
  }));
}

function transfer(db, { dist_id, actor_id, recipient_ids }) {
  return withTx(db, () => {
    const d = mustDist(db, dist_id);
    if (d.current_step !== 3) throw new SqlError('CONFLICT', '不在移交步骤');
    for (const eid of recipient_ids) {
      db.prepare("UPDATE distribution_recipient SET status='已移交', transferred_at=CURRENT_TIMESTAMP WHERE distribution_id=? AND employee_id=? AND status='待接收'")
        .run(dist_id, eid);
    }
    const left = db.prepare("SELECT COUNT(*) c FROM distribution_recipient WHERE distribution_id=? AND status='待接收'").get(dist_id).c;
    if (left === 0) {
      db.prepare("UPDATE workflow_step SET status='已完成',completed_at=CURRENT_TIMESTAMP WHERE ref_type='distribution' AND ref_id=? AND step_no=3").run(dist_id);
      db.prepare("UPDATE distribution SET current_step=4,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(dist_id);
      db.prepare("UPDATE workflow_step SET status='进行中' WHERE ref_type='distribution' AND ref_id=? AND step_no=4").run(dist_id);
    }
    recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 3, event: 'transfer', actor_id, payload: { recipient_ids } });
    return { ok: true };
  });
}

function signoff(db, { dist_id, actor_id, idempotency_key = null }) {
  return withIdem(db, idempotency_key, actor_id, () => withTx(db, () => {
    const d = mustDist(db, dist_id);
    if (d.current_step !== 4) throw new SqlError('CONFLICT', '不在签收步骤');
    if (policy(db, 'signoff.self_only') !== 'true') throw new SqlError('FORBIDDEN', '策略未启用 self-only');
    const r = db.prepare('SELECT * FROM distribution_recipient WHERE distribution_id=? AND employee_id=?').get(dist_id, actor_id);
    if (!r) throw new SqlError('FORBIDDEN', '只能签收本人名下物资(self-only)');
    if (r.status === '已接收') return { ok: true, noop: true };
    db.prepare("UPDATE distribution_recipient SET status='已接收', received_at=CURRENT_TIMESTAMP WHERE id=?").run(r.id);
    const left = db.prepare("SELECT COUNT(*) c FROM distribution_recipient WHERE distribution_id=? AND status<>'已接收'").get(dist_id).c;
    if (left === 0) {
      db.prepare("UPDATE workflow_step SET status='已完成',completed_at=CURRENT_TIMESTAMP WHERE ref_type='distribution' AND ref_id=? AND step_no=4").run(dist_id);
      db.prepare("UPDATE distribution SET status='已完成',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(dist_id);
    }
    recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 4, event: 'signoff', actor_id });
    return { ok: true };
  }));
}

function addRecipients(db, dist_id, employee_ids) {
  const ins = db.prepare('INSERT INTO distribution_recipient(distribution_id,employee_id,status) VALUES(?,?,?)');
  for (const eid of employee_ids) ins.run(dist_id, eid, '待接收');
}

// ---------- 入库质检(A-T9) ----------
function createInbound(db, { operator_id, lines, depot_id = 'DP-001' }) {
  for (const l of lines) {
    const it = db.prepare('SELECT depot_id FROM inventory_item WHERE id=?').get(l.item_id);
    if (!it || it.depot_id !== depot_id) throw new SqlError('DEPOT_MISMATCH', `物资 ${l.item_id} 不能入到 ${depot_id}`);
  }
  return withTx(db, () => {
    const id = nextId(db, 'IN');
    const total = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
    db.prepare("INSERT INTO inbound_record(id,date,type,total_cost,operator_id,status,depot_id) VALUES(?,date('now'),'采购入库',?,?,'待质检',?)")
      .run(id, total, operator_id, depot_id);
    const line = db.prepare('INSERT INTO inbound_line(inbound_id,line_no,item_id,qty,unit_cost) VALUES(?,?,?,?,?)');
    lines.forEach((l, i) => line.run(id, i + 1, l.item_id, l.qty, l.unit_cost));
    return id;
  });
}
function recordQuality(db, { inbound_id, result, inspector_id }) {
  return withTx(db, () => {
    db.prepare('UPDATE inbound_record SET quality_result=?, quality_inspector_id=?, status=CASE WHEN ?=? THEN ? ELSE status END WHERE id=?')
      .run(result, inspector_id, result, '合格', '已完成', inbound_id);
    if (result === '合格') {
      const lines = db.prepare('SELECT * FROM inbound_line WHERE inbound_id=? ORDER BY line_no').all(inbound_id);
      for (const l of lines) {
        deductOnce(db, { item_id: l.item_id, qty: -l.qty, reason: 'inbound', ref_type: 'inbound', ref_id: inbound_id, line_no: l.line_no, actor_id: inspector_id });
      }
    }
  });
}

// ---------- 工具 ----------
const mustDist = (db, id) => { const d = db.prepare('SELECT * FROM distribution WHERE id=?').get(id); if (!d) throw new SqlError('NOT_FOUND', `发放单不存在: ${id}`); return d; };
let seq = { MD: 0, IN: 0 };
function nextId(db, pfx) { seq[pfx] = (seq[pfx] || 0) + 1; return `${pfx}-2026-${String(seq[pfx]).padStart(3, '0')}`; }

// 驱动一个已批准、含接收人、可直达 step4 的发放单
function approvedDist(db, { total_people, lines, recipients, depot_id = 'DP-001', approval_id = 'WF-1' }) {
  const id = createDistribution(db, { applicant_id: 4, department: 'x', scope: 'all', scope_desc: 'x', total_people, distributor_id: 11, lines, approval_id, depot_id });
  addRecipients(db, id, recipients);
  approveDistribution(db, { dist_id: id, actor_id: 4, approval_completed: true });
  return id;
}
function driveToStep4(db, distId) {
  completeStep(db, { dist_id: distId, step_no: 1, actor_id: 5 });
  completeStep(db, { dist_id: distId, step_no: 2, actor_id: 11 });
  const recips = db.prepare('SELECT employee_id FROM distribution_recipient WHERE distribution_id=?').all(distId).map(r => r.employee_id);
  transfer(db, { dist_id: distId, actor_id: 11, recipient_ids: recips });
}

// ================= 验收测试 =================
test('A-T1 step1 事务扣减库存+流水', () => {
  const db = freshDb();
  const id = approvedDist(db, { total_people: 40, lines: [{ item_id: 'INV-001', per_person_qty: 2 }], recipients: [13] });
  completeStep(db, { dist_id: id, step_no: 1, actor_id: 5 });
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock, 420);
  const mv = db.prepare("SELECT * FROM stock_movement WHERE ref_id=? AND reason='distribution_out'").get(id);
  assert.equal(mv.delta, -80); assert.equal(mv.qty_after, 420); assert.equal(mv.depot_id, 'DP-001');
});

test('A-T2 库存不足回滚(G2)', () => {
  const db = freshDb();
  const id = approvedDist(db, { total_people: 10, lines: [{ item_id: 'INV-004', per_person_qty: 2 }], recipients: [13] });
  assert.throws(() => completeStep(db, { dist_id: id, step_no: 1, actor_id: 5 }), /库存不足/);
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-004').stock, 15); // 未扣
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_movement WHERE ref_id=?').get(id).c, 0);
});

test('A-T3 审批前置(G3)', () => {
  const db = freshDb();
  const id = createDistribution(db, { applicant_id: 4, department: 'x', scope: 'all', scope_desc: 'x', total_people: 1, distributor_id: 11, lines: [{ item_id: 'INV-001', per_person_qty: 1 }], approval_id: null, depot_id: 'DP-001' });
  assert.throws(() => approveDistribution(db, { dist_id: id, actor_id: 4, approval_completed: false }), /审批/);
});

test('A-T5 仅本人签收(反舞弊)', () => {
  const db = freshDb();
  const id = approvedDist(db, { total_people: 40, lines: [{ item_id: 'INV-001', per_person_qty: 2 }], recipients: [7, 13] });
  driveToStep4(db, id);
  assert.equal(signoff(db, { dist_id: id, actor_id: 13 }).ok, true);      // 接收人13签自己→成功
  assert.throws(() => signoff(db, { dist_id: id, actor_id: 4 }), /self-only|FORBIDDEN/); // 非接收人→拒
});

test('A-T6 幂等重放不重复扣减', () => {
  const db = freshDb();
  const id = approvedDist(db, { total_people: 40, lines: [{ item_id: 'INV-001', per_person_qty: 2 }], recipients: [13] });
  const key = 'k-offline-1';
  completeStep(db, { dist_id: id, step_no: 1, actor_id: 5, idempotency_key: key });
  const mid = db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock;
  completeStep(db, { dist_id: id, step_no: 1, actor_id: 5, idempotency_key: key }); // 重放
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock, mid);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_movement WHERE ref_id=?').get(id).c, 1);
});

test('A-T9 入库质检门(不合格不加库存)', () => {
  const db = freshDb();
  const before = db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock;
  const inId = createInbound(db, { operator_id: 5, lines: [{ item_id: 'INV-001', qty: 500, unit_cost: 250 }] });
  recordQuality(db, { inbound_id: inId, result: '不合格', inspector_id: 5 });
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock, before);
  recordQuality(db, { inbound_id: inId, result: '合格', inspector_id: 5 });
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock, before + 500);
});

test('A-T10 审计链可校验+防篡改(G5)', () => {
  const db = freshDb();
  const id = approvedDist(db, { total_people: 40, lines: [{ item_id: 'INV-001', per_person_qty: 2 }], recipients: [13] });
  driveToStep4(db, id);
  signoff(db, { dist_id: id, actor_id: 13 });
  assert.equal(verifyChain(db, 'distribution', id), true);
  const mid = db.prepare('SELECT id FROM chain_event WHERE ref_id=? ORDER BY id LIMIT 1 OFFSET 1').get(id);
  db.prepare('UPDATE chain_event SET payload=? WHERE id=?').run('{"tampered":true}', mid.id);
  assert.equal(verifyChain(db, 'distribution', id), false);
});

test('A-T11 低库存查询', () => {
  const db = freshDb();
  const low = db.prepare('SELECT id FROM inventory_item WHERE stock < min_stock').all().map(r => r.id);
  assert.ok(low.includes('INV-004'));
});

test('A-T13 多仓隔离(决策#3)', () => {
  const db = freshDb();
  // ① 跨仓出库:从 DP-002 发 DP-001 的 INV-001 → 创建即拒
  assert.throws(() => createDistribution(db, {
    applicant_id: 4, department: 'x', scope: 'all', scope_desc: 'x', total_people: 1, distributor_id: 11,
    lines: [{ item_id: 'INV-001', per_person_qty: 1 }], approval_id: 'WF-3', depot_id: 'DP-002',
  }), /DEPOT_MISMATCH|属于仓/);
  // ② 仓间隔离:二仓 INV-201 仅 5,领 20 → 拒;总部仓 500 不受影响
  const req = approvedDist(db, { total_people: 20, lines: [{ item_id: 'INV-201', per_person_qty: 1 }], recipients: [13], depot_id: 'DP-002', approval_id: 'WF-4' });
  assert.throws(() => completeStep(db, { dist_id: req, step_no: 1, actor_id: 5 }), /库存不足（仓 DP-002）/);
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-201').stock, 5);
  assert.equal(db.prepare('SELECT stock FROM inventory_item WHERE id=?').get('INV-001').stock, 500);
});
