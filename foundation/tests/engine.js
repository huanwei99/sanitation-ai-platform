// engine.js — 子系统A 领域引擎（内存仓库层）
// 目的：用纯 JS 忠实复刻 001_init.sql 的不变量，证明状态机与库存控制逻辑正确。
// 不变量与 SQL 一一对应，落地时把这里的校验搬进 SQL 事务即可。
'use strict';
const crypto = require('node:crypto');

class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 读取 org_policy
const POLICY = {
  'distribution.require_approval': 'true',
  'requisition.require_approval': 'true',
  'signoff.self_only': 'true',
};

function newDb() {
  return {
    employees: new Map(),        // id -> employee
    permissions: new Map(),      // employee_id -> perm
    inventory: new Map(),        // id -> item
    stock_movement: [],          // 追加台账
    distribution: new Map(),     // id -> dist
    distribution_recipient: [],  // 接收人
    distribution_line: [],       // 行
    requisition: new Map(),
    requisition_line: [],
    workflow_step: [],           // {ref_type,ref_id,step_no,name,assignee_id,status,completed_at,note}
    chain_event: [],             // 追加审计
    idempotency: new Map(),      // key -> {code, body}
    sessions: new Map(),         // token -> employee_id
    policy: { ...POLICY },
  };
}

// ---------- 审计链（哈希串联，防篡改） ----------
function hashEvent(db, ev) {
  const prev = db.chain_event.length ? db.chain_event[db.chain_event.length - 1].event_hash : '';
  const payload = JSON.stringify({ ...ev, prev });
  return crypto.createHash('sha256').update(payload).digest('hex');
}
function recordEvent(db, { ref_type, ref_id, step_no = null, event, actor_id, actor_role = '', payload = {}, captured_at = null }) {
  const ev = { ref_type, ref_id, step_no, event, actor_id, actor_role, payload, captured_at, occurred_at: new Date().toISOString() };
  ev.prev_event_hash = db.chain_event.length ? db.chain_event[db.chain_event.length - 1].event_hash : '';
  ev.event_hash = hashEvent(db, ev);
  db.chain_event.push(ev);
  return ev;
}
// 重新校验整条链（A-T10）：既校验链接指针，也重算每条事件自身哈希
function verifyChain(db) {
  let prev = '';
  for (const ev of db.chain_event) {
    if (ev.prev_event_hash !== prev) return false;          // 链接被断
    const { event_hash, ...rest } = ev;                      // 去掉自身哈希
    const expect = crypto.createHash('sha256')
      .update(JSON.stringify({ ...rest, prev })).digest('hex');
    if (expect !== event_hash) return false;                 // 内容被篡改
    prev = event_hash;
  }
  return true;
}

// ---------- 库存台账（唯一写入口，保证 stock === 最新 qty_after） ----------
function applyMovement(db, { item_id, delta, reason, ref_type, ref_id, line_no, actor_id }) {
  const item = db.inventory.get(item_id);
  if (!item) throw new DomainError('NOT_FOUND', `库存不存在: ${item_id}`);
  const newStock = item.stock + delta;
  if (newStock < 0) {
    throw new DomainError('STOCK_SHORTFALL',
      `库存不足: ${item_id} 可用=${item.stock} 需求=${-delta}`);
  }
  item.stock = newStock;
  item.updated_at = new Date().toISOString();
  const mv = { item_id, delta, reason, ref_type, ref_id, line_no, qty_after: newStock, actor_id, occurred_at: new Date().toISOString() };
  db.stock_movement.push(mv);
  return mv;
}

// ---------- 种子数据（复刻原型 index.html 的值） ----------
function seed(db) {
  const emp = (id, name, position, department) =>
    db.employees.set(id, { employee_id: id, name, position, department });
  emp(4, '刘洋', '项目经理', '综合管理部');
  emp(5, '陈静', '仓库负责人', '综合管理部');
  emp(7, '孙磊', '车队长', '机械作业部');
  emp(11, '马丽', '片区经理', '人工作业部');
  emp(13, '林小红', '班组长', '人工作业部');
  emp(16, '胡明', '机动保洁队长', '人工作业部');

  // 权限：仓库负责人可出库，片区经理可发放，决策层 L1 全权
  db.permissions.set(5, { level: 3, scope: 'project', modules: { materials: ['view', 'edit'] }, admin_level: 0 });
  db.permissions.set(11, { level: 3, scope: 'project', modules: { materials: ['view', 'edit', 'admin'] }, admin_level: 0 });
  db.permissions.set(4, { level: 1, scope: 'group', modules: 'ALL', admin_level: 3 });

  const inv = (id, name, spec, category, unit, stock, minStock, cost) =>
    db.inventory.set(id, { id, name, spec, category, unit, stock, min_stock: minStock, unit_cost: cost, is_rented: 0 });
  inv('INV-001', '保洁手套', '乳胶加厚', 'consumable', '双', 500, 100, 250);
  inv('INV-004', '工作服', '秋冬款带反光条', 'consumable', '套', 15, 20, 8500);
  inv('INV-006', '机油', '15W-40 柴机油', 'consumable', '桶', 10, 5, 18000);
  return db;
}

// ---------- 发放（4步） ----------
function createDistribution(db, { applicant_id, department, scope, scope_desc, total_people, distributor_id, lines, approval_id = null }) {
  const requireApproval = db.policy['distribution.require_approval'] === 'true';
  if (requireApproval && !approval_id) {
    // G3：默认策略下必须有审批单（此处只挂一个待审批引用；approve 时校验已完成）
    if (approval_id === null && requireApproval) {
      // 允许创建，但状态停在 待审批，approve 阶段强制校验 approval 已完成
    }
  }
  // 计算每行 qty = per_person_qty * total_people
  const distId = nextId(db, 'MD');
  const dist = {
    id: distId, applicant_id, department, requested_at: new Date().toISOString(),
    scope, scope_desc, total_people, distributor_id, approval_id,
    status: '待审批', current_step: 0, total_steps: 4,
  };
  db.distribution.set(distId, dist);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    db.distribution_line.push({
      distribution_id: distId, line_no: i + 1, item_id: l.item_id,
      per_person_qty: l.per_person_qty, qty: l.per_person_qty * total_people,
    });
  }
  return distId;
}

function approveDistribution(db, { dist_id, actor_id, approval_completed = true }) {
  const d = mustDist(db, dist_id);
  if (d.status !== '待审批') throw new DomainError('INVALID_STATE', `当前状态 ${d.status}，不能审批`);
  const requireApproval = db.policy['distribution.require_approval'] === 'true';
  if (requireApproval && (!d.approval_id || !approval_completed)) {
    throw new DomainError('APPROVAL_MISSING', '缺少已完成的审批，无法生成执行链（G3）');
  }
  d.status = '已批准';
  d.current_step = 1;
  ensureSteps(db, 'distribution', dist => [
    { step_no: 1, name: '仓库出库', assignee_id: 5 },
    { step_no: 2, name: '发放人接收', assignee_id: d.distributor_id },
    { step_no: 3, name: '发放人移交', assignee_id: d.distributor_id },
    { step_no: 4, name: '接收人接收', assignee_id: null },
  ])(d);
  setStep(db, 'distribution', dist_id, 1, '进行中');
  recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, event: 'approval_granted', actor_id });
  return d;
}

// 完成 step1：事务性扣减库存（G1/G2 核心）
function completeDistributionStep(db, { dist_id, step_no, actor_id, idempotency_key = null }) {
  return withIdempotency(db, idempotency_key, () => {
    const d = mustDist(db, dist_id);
    if (d.current_step !== step_no) throw new DomainError('CONFLICT', `步骤冲突：期望 ${d.current_step}，收到 ${step_no}`);
    const step = getStep(db, 'distribution', dist_id, step_no);
    if (step.status !== '进行中') throw new DomainError('INVALID_STATE', `步骤 ${step_no} 状态 ${step.status}`);

    if (step_no === 1) {
      const lines = db.distribution_line.filter(l => l.distribution_id === dist_id);
      // 先校验全部行库存（G2），再统一扣减（同一事务语义）
      for (const l of lines) {
        const item = db.inventory.get(l.item_id);
        if (item.stock < l.qty) {
          throw new DomainError('STOCK_SHORTFALL',
            `库存不足: ${l.item_id} 可用=${item.stock} 需求=${l.qty}`);
        }
      }
      for (const l of lines) {
        applyMovement(db, { item_id: l.item_id, delta: -l.qty, reason: 'distribution_out', ref_type: 'distribution', ref_id: dist_id, line_no: l.line_no, actor_id });
        recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 1, event: 'stock_deducted', actor_id, payload: { item_id: l.item_id, qty: l.qty } });
      }
      step.status = '已完成'; step.completed_at = new Date().toISOString();
      d.current_step = 2; d.status = '发放中';
      setStep(db, 'distribution', dist_id, 2, '进行中');
      recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 1, event: 'step_completed', actor_id });
      return { ok: true };
    }

    if (step_no === 2) {
      step.status = '已完成'; step.completed_at = new Date().toISOString();
      d.current_step = 3;
      setStep(db, 'distribution', dist_id, 3, '进行中');
      recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 2, event: 'step_completed', actor_id });
      return { ok: true };
    }
    throw new DomainError('INVALID_STEP', `步骤 ${step_no} 需走专用接口（移交/签收）`);
  });
}

// step3 移交（分批、幂等、单调）
function transfer(db, { dist_id, actor_id, recipient_ids, idempotency_key = null }) {
  return withIdempotency(db, idempotency_key, () => {
    const d = mustDist(db, dist_id);
    if (d.current_step !== 3) throw new DomainError('CONFLICT', '当前不在移交步骤');
    let changed = 0;
    for (const rid of recipient_ids) {
      const r = db.distribution_recipient.find(x => x.distribution_id === dist_id && x.employee_id === rid);
      if (!r) continue;
      if (r.status === '待接收') { r.status = '已移交'; r.transferred_at = new Date().toISOString(); changed++; }
      // 已移交/已接收 → 幂等 no-op（单调）
    }
    const allDone = db.distribution_recipient.filter(x => x.distribution_id === dist_id)
      .every(r => r.status === '已移交' || r.status === '已接收');
    if (allDone) {
      const s3 = getStep(db, 'distribution', dist_id, 3);
      s3.status = '已完成'; s3.completed_at = new Date().toISOString();
      d.current_step = 4;
      setStep(db, 'distribution', dist_id, 4, '进行中');
    }
    recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 3, event: 'transfer', actor_id, payload: { recipient_ids, changed } });
    return { changed, allDone };
  });
}

// step4 签收（仅本人，A-T5）
function signoff(db, { dist_id, actor_id, idempotency_key = null, captured_at = null }) {
  return withIdempotency(db, idempotency_key, () => {
    const d = mustDist(db, dist_id);
    if (d.current_step !== 4) throw new DomainError('CONFLICT', '当前不在签收步骤');
    if (db.policy['signoff.self_only'] === 'true') {
      const r = db.distribution_recipient.find(x => x.distribution_id === dist_id && x.employee_id === actor_id);
      if (!r) throw new DomainError('FORBIDDEN', '只能签收本人名下的物资（self-only）');
      if (r.status === '已接收') return { ok: true, noop: true };  // 幂等
      r.status = '已接收'; r.received_at = new Date().toISOString();
    } else {
      throw new DomainError('FORBIDDEN', '策略未启用 self-only，暂不支持代签');
    }
    const recips = db.distribution_recipient.filter(x => x.distribution_id === dist_id);
    const allReceived = recips.every(r => r.status === '已接收');
    if (allReceived) {
      const s4 = getStep(db, 'distribution', dist_id, 4);
      s4.status = '已完成'; s4.completed_at = new Date().toISOString();
      d.status = '已完成';
    }
    recordEvent(db, { ref_type: 'distribution', ref_id: dist_id, step_no: 4, event: 'signoff', actor_id, captured_at });
    return { ok: true, allReceived };
  });
}

// ---------- 领取（2步，G6 同样扣库存） ----------
function createRequisition(db, { applicant_id, department, urgency, req_type, reason, approver_id, lines, approval_id = null }) {
  const reqId = nextId(db, 'MR');
  db.requisition.set(reqId, {
    id: reqId, applicant_id, department, requested_at: new Date().toISOString(),
    urgency, req_type, reason, approver_id, approval_id,
    status: '审批中', current_step: 0, total_steps: 2,
  });
  for (let i = 0; i < lines.length; i++) {
    db.requisition_line.push({ requisition_id: reqId, line_no: i + 1, item_id: lines[i].item_id, qty: lines[i].qty });
  }
  return reqId;
}
function approveRequisition(db, { req_id, actor_id, approval_completed = true }) {
  const r = mustReq(db, req_id);
  if (r.status !== '审批中') throw new DomainError('INVALID_STATE', `当前状态 ${r.status}`);
  if (db.policy['requisition.require_approval'] === 'true' && (!r.approval_id || !approval_completed)) {
    throw new DomainError('APPROVAL_MISSING', '缺少已完成审批（G3）');
  }
  r.status = '已批准'; r.current_step = 1;
  ensureSteps(db, 'requisition', req => [
    { step_no: 1, name: '仓库出库', assignee_id: 5 },
    { step_no: 2, name: '领取人签收', assignee_id: r.applicant_id },
  ])(r);
  setStep(db, 'requisition', req_id, 1, '进行中');
  recordEvent(db, { ref_type: 'requisition', ref_id: req_id, event: 'approval_granted', actor_id });
  return r;
}
function completeRequisitionStep(db, { req_id, step_no, actor_id, idempotency_key = null }) {
  return withIdempotency(db, idempotency_key, () => {
    const r = mustReq(db, req_id);
    if (r.current_step !== step_no) throw new DomainError('CONFLICT', `步骤冲突：期望 ${r.current_step}`);
    const step = getStep(db, 'requisition', req_id, step_no);
    if (step.status !== '进行中') throw new DomainError('INVALID_STATE', `步骤 ${step_no} 状态 ${step.status}`);
    if (step_no === 1) {
      const lines = db.requisition_line.filter(l => l.requisition_id === req_id);
      for (const l of lines) {
        const item = db.inventory.get(l.item_id);
        if (item.stock < l.qty) throw new DomainError('STOCK_SHORTFALL', `库存不足: ${l.item_id} 可用=${item.stock} 需求=${l.qty}`);
      }
      for (const l of lines) {
        applyMovement(db, { item_id: l.item_id, delta: -l.qty, reason: 'requisition_out', ref_type: 'requisition', ref_id: req_id, line_no: l.line_no, actor_id });
        recordEvent(db, { ref_type: 'requisition', ref_id: req_id, step_no: 1, event: 'stock_deducted', actor_id, payload: { item_id: l.item_id, qty: l.qty } });
      }
      step.status = '已完成'; step.completed_at = new Date().toISOString();
      r.current_step = 2; r.status = '发放中';
      setStep(db, 'requisition', req_id, 2, '进行中');
      recordEvent(db, { ref_type: 'requisition', ref_id: req_id, step_no: 1, event: 'step_completed', actor_id });
      return { ok: true };
    }
    if (step_no === 2) {
      step.status = '已完成'; step.completed_at = new Date().toISOString();
      r.status = '已完成';
      recordEvent(db, { ref_type: 'requisition', ref_id: req_id, step_no: 2, event: 'signoff', actor_id });
      return { ok: true };
    }
  });
}

// ---------- 入库 + 质检（A-T9） ----------
function createInbound(db, { supplier, operator_id, lines, approval_id = null }) {
  const inId = nextId(db, 'IN');
  const total = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
  db.inbound = db.inbound || new Map();
  db.inbound.set(inId, { id: inId, date: new Date().toISOString().slice(0, 10), type: '采购入库', supplier, total_cost: total, operator_id, status: '待质检', approval_id, lines });
  return inId;
}
function recordQuality(db, { inbound_id, result, inspector_id }) {
  db.inbound = db.inbound || new Map();
  const inb = db.inbound.get(inbound_id);
  if (!inb) throw new DomainError('NOT_FOUND', '入库单不存在');
  inb.quality_result = result;
  if (result === '合格') {
    inb.status = '已完成';
    for (let i = 0; i < inb.lines.length; i++) {
      const l = inb.lines[i];
      applyMovement(db, { item_id: l.item_id, delta: l.qty, reason: 'inbound', ref_type: 'inbound', ref_id: inbound_id, line_no: i + 1, actor_id: inspector_id });
    }
  }
  // 不合格 → 不增库存，状态保持 待质检/未完成
  return inb;
}

// ---------- 工具 ----------
function withIdempotency(db, key, fn) {
  if (!key) return fn();
  if (db.idempotency.has(key)) return db.idempotency.get(key);   // 重放返回首次结果
  try {
    const result = fn();
    db.idempotency.set(key, result);
    return result;
  } catch (e) {
    // 失败不缓存，允许重试；但 STOCK_SHORTFALL 等确定性失败也可缓存——此处按“失败可重试”
    throw e;
  }
}
function mustDist(db, id) { const d = db.distribution.get(id); if (!d) throw new DomainError('NOT_FOUND', `发放单不存在: ${id}`); return d; }
function mustReq(db, id) { const r = db.requisition.get(id); if (!r) throw new DomainError('NOT_FOUND', `领取单不存在: ${id}`); return r; }
function getStep(db, ref_type, ref_id, step_no) {
  return db.workflow_step.find(s => s.ref_type === ref_type && s.ref_id === ref_id && s.step_no === step_no);
}
function setStep(db, ref_type, ref_id, step_no, status) { const s = getStep(db, ref_type, ref_id, step_no); if (s) s.status = status; }
function ensureSteps(db, ref_type, build) {
  return (doc) => {
    for (const st of build(doc)) {
      db.workflow_step.push({ ref_type, ref_id: doc.id, step_no: st.step_no, name: st.name, assignee_id: st.assignee_id, status: '待执行', completed_at: null, note: '' });
    }
  };
}
function addRecipients(db, dist_id, recipients) {
  for (const r of recipients) {
    db.distribution_recipient.push({ distribution_id: dist_id, employee_id: r.employee_id, units: r.units || '', people_count: r.people_count || 0, allocated_items: r.allocated_items || '', status: '待接收', transferred_at: null, received_at: null });
  }
}
let counters = { MD: 0, MR: 0, IN: 0 };
function nextId(db, prefix) { counters[prefix] = (counters[prefix] || 0) + 1; return `${prefix}-2026-${String(counters[prefix]).padStart(3, '0')}`; }

module.exports = {
  DomainError, newDb, seed, recordEvent, verifyChain,
  createDistribution, approveDistribution, completeDistributionStep, transfer, signoff, addRecipients,
  createRequisition, approveRequisition, completeRequisitionStep,
  createInbound, recordQuality,
};
