// emergency.js — P2-T03 清雪应急指挥调度:领域逻辑
// 五阶段状态机 + 战报引擎 + 外租/自有设备混合调度。
// 领域纯逻辑,不碰 Fastify;路由层(emergency-routes.js)负责 HTTP 与权限门控。
// 复用:chain.js 的 recordEvent / verifyChain、db.js 的 transaction。

const { recordEvent, verifyChain } = require('./chain');

// ---- 错误类型 ----
class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const badRequest = (m) => new ApiError('BAD_REQUEST', m);
const notFound = (m) => new ApiError('NOT_FOUND', m);
const conflict = (m) => new ApiError('CONFLICT', m);

// ---- 五阶段状态机 ----
// alert(预警/上报) → verified(核实) → activated(启动预案) → executing(执行跟踪) → resolved(结案/复盘)
// cancelled(误报) 可从 alert/verified/activated 进入;executing 不允许 cancel(只能走结案)。
const STATE_TRANSITIONS = {
  alert:     ['verified', 'cancelled'],
  verified:  ['activated', 'cancelled'],
  activated: ['executing', 'cancelled'],
  executing: ['resolved'],
  resolved:  [],
  cancelled: [],
};

// 目标状态 → 写入 chain_event 的事件类型
const EVENT_TYPE_FOR_TARGET = {
  verified:  'event_verified',
  activated: 'event_activated',
  executing: 'event_start_executing',
  resolved:  'event_resolved',
  cancelled: 'event_cancelled',
};

const ACTIVE_STATUSES = ['alert', 'verified', 'activated', 'executing'];

function assertTransition(from, to) {
  const allowed = STATE_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    // 状态机违反属前置条件冲突,映射为 409 Conflict
    throw conflict(`非法状态转移:${from} → ${to}(合法后继:${allowed.join(',') || '无'})`);
  }
}

function getEvent(db, eventId) {
  return db.prepare('SELECT * FROM emergency_event WHERE id = ?').get(eventId);
}
function assertEventExists(db, eventId) {
  const ev = getEvent(db, eventId);
  if (!ev) throw notFound(`应急事件不存在:${eventId}`);
  return ev;
}

function _parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---- 创建事件(alert 态)----
function createEvent(db, payload, actor) {
  const { plan_id, title, category, level, commander_id = null, deputy_commander_id = null, situation = {} } = payload;
  if (!plan_id || !title || !category || !level) {
    throw badRequest('需要 plan_id / title / category / level');
  }
  const plan = db.prepare('SELECT id FROM emergency_plan WHERE id = ?').get(plan_id);
  if (!plan) throw badRequest(`预案不存在:${plan_id}`);
  if (actor == null || actor.employee_id == null) throw badRequest('缺少操作人');

  const info = db.prepare(
    `INSERT INTO emergency_event (plan_id, title, category, level, status, start_time,
       commander_id, deputy_commander_id, situation, created_by)
     VALUES (?,?,?,?, 'alert', CURRENT_TIMESTAMP, ?,?, ?, ?)`
  ).run(plan_id, title, category, level, commander_id, deputy_commander_id,
        JSON.stringify(situation || {}), actor.employee_id);
  const eventId = Number(info.lastInsertRowid);

  db.transaction(() => {
    recordEvent(db, { ref_type: 'emergency', ref_id: String(eventId), event: 'event_created', actor_id: actor.employee_id, actor_role: actor.actor_role || '', payload: { plan_id, title, category, level } });
  })();

  return getEvent(db, eventId);
}

// ---- 状态转移 ----
// toStatus: verified/activated/executing/resolved/cancelled
function transition(db, eventId, toStatus, actor, note = '') {
  const ev = assertEventExists(db, eventId);
  assertTransition(ev.status, toStatus);
  const eventType = EVENT_TYPE_FOR_TARGET[toStatus];

  db.transaction(() => {
    const endTime = (toStatus === 'resolved' || toStatus === 'cancelled') ? 'CURRENT_TIMESTAMP' : 'NULL';
    db.prepare(
      `UPDATE emergency_event SET status = ?, end_time = ${endTime}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(toStatus, eventId);
    db.prepare(
      'INSERT INTO emergency_progress_log (event_id, action, actor_id, detail) VALUES (?,?,?,?)'
    ).run(eventId, `状态转移:${ev.status}→${toStatus}`, actor?.employee_id || null, note || null);
    recordEvent(db, { ref_type: 'emergency', ref_id: String(eventId), event: eventType, actor_id: actor?.employee_id || 0, actor_role: actor?.actor_role || '', payload: { from: ev.status, to: toStatus, note } });
  })();

  return getEvent(db, eventId);
}

// ---- 调度(外租+自有设备混合调度,分配动作,不改库存/外租台账)----
function _deriveResourceName(db, resourceType, source, inventoryItemId, rentalItemId, employeeId) {
  if (source === 'own' && inventoryItemId) {
    const it = db.prepare('SELECT name FROM inventory_item WHERE id = ?').get(inventoryItemId);
    if (it) return it.name;
  }
  if (source === 'rented' && rentalItemId) {
    const ri = db.prepare('SELECT item_id, serial_no FROM rental_item WHERE id = ?').get(rentalItemId);
    if (ri) {
      const it = db.prepare('SELECT name FROM inventory_item WHERE id = ?').get(ri.item_id);
      const base = it ? it.name : '外租设备';
      return ri.serial_no ? `${base}(${ri.serial_no})` : base;
    }
  }
  if (resourceType === 'personnel' && employeeId) {
    const emp = db.prepare('SELECT name FROM employees WHERE employee_id = ?').get(employeeId);
    if (emp) return emp.name;
  }
  return '未命名资源';
}

// 资源可用性校验:存在且处于可用状态
// 人员:只需 employee_id(source 对人员无意义,恒为自有);
// 设备/物资(vehicle/material):source 区分 own/rented,对应不同外键。
function _assertResourceAvailable(db, resourceType, source, inventoryItemId, rentalItemId, employeeId) {
  if (resourceType === 'personnel') {
    if (!employeeId) throw badRequest('人员调度需提供 employee_id');
    const emp = db.prepare('SELECT employee_id, is_active FROM employees WHERE employee_id = ?').get(employeeId);
    if (!emp) throw badRequest(`人员不存在:${employeeId}`);
    if (!emp.is_active) throw conflict(`人员 ${employeeId} 已停用,不可调度`);
    return;
  }
  if (!['own', 'rented'].includes(source)) throw badRequest('source 需为 own 或 rented');
  if (source === 'own') {
    if (!inventoryItemId) throw badRequest('自有资源需提供 inventory_item_id');
    const it = db.prepare('SELECT id, is_rented FROM inventory_item WHERE id = ?').get(inventoryItemId);
    if (!it) throw badRequest(`自有物资不存在:${inventoryItemId}`);
    if (it.is_rented) throw conflict(`物资 ${inventoryItemId} 为外租物资,不可作自有调度`);
  } else {
    if (!rentalItemId) throw badRequest('外租资源需提供 rental_item_id');
    const ri = db.prepare('SELECT id, status FROM rental_item WHERE id = ?').get(rentalItemId);
    if (!ri) throw badRequest(`外租设备不存在:${rentalItemId}`);
    if (ri.status !== 'rented') throw conflict(`外租设备 ${rentalItemId} 已归还,不可调度`);
  }
}

// 设备(自有/外租)不可重复分配到任何进行中事件(含本事件,防止同一设备被重复调度)
function _assertNotInActiveEvent(db, source, inventoryItemId, rentalItemId, eventId) {
  const col = source === 'own' ? 'inventory_item_id' : 'rental_item_id';
  const val = source === 'own' ? inventoryItemId : rentalItemId;
  const row = db.prepare(
    `SELECT d.id, e.title FROM emergency_dispatch d
       JOIN emergency_event e ON e.id = d.event_id
      WHERE d.${col} = ? AND e.status IN ('alert','verified','activated','executing')
      LIMIT 1`
  ).get(val);
  if (row) throw conflict(`资源已分配给进行中的事件「${row.title}」(调度#${row.id})`);
}

function dispatch(db, eventId, payload, actor) {
  const ev = assertEventExists(db, eventId);
  if (!ACTIVE_STATUSES.includes(ev.status)) {
    throw conflict(`事件已处于终态(${ev.status}),不可调度`);
  }
  const { resource_type, source, inventory_item_id, rental_item_id, employee_id, assigned_role, area, note, status } = payload;
  if (!['personnel', 'vehicle', 'material'].includes(resource_type)) {
    throw badRequest('resource_type 需为 personnel/vehicle/material');
  }
  // 人员恒为自有;设备/物资 source 由调用方给出,缺省 own
  const src = resource_type === 'personnel' ? 'own' : (source || 'own');
  _assertResourceAvailable(db, resource_type, src, inventory_item_id, rental_item_id, employee_id);
  // 设备类资源做「不重复分配到进行中事件」校验(人员允许多任务)
  if (resource_type !== 'personnel') {
    _assertNotInActiveEvent(db, src, inventory_item_id, rental_item_id, eventId);
  }
  const resourceName = payload.resource_name ||
    _deriveResourceName(db, resource_type, src, inventory_item_id, rental_item_id, employee_id);

  const info = db.prepare(
    `INSERT INTO emergency_dispatch (event_id, resource_type, source, inventory_item_id, rental_item_id,
       employee_id, resource_name, status, assigned_role, area, note, created_by)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?,?)`
  ).run(eventId, resource_type, src, inventory_item_id || null, rental_item_id || null,
        employee_id || null, resourceName, status || 'assigned', assigned_role || null, area || null, note || null,
        actor?.employee_id || 0);
  const dispatchId = Number(info.lastInsertRowid);

  db.transaction(() => {
    recordEvent(db, { ref_type: 'emergency', ref_id: String(eventId), event: 'dispatch', actor_id: actor?.employee_id || 0, actor_role: actor?.actor_role || '', payload: { dispatch_id: dispatchId, resource_type, source, resource_name: resourceName, area } });
  })();

  return db.prepare('SELECT * FROM emergency_dispatch WHERE id = ?').get(dispatchId);
}

// ---- 进度日志 ----
function addProgressLog(db, eventId, action, detail, actor) {
  const ev = assertEventExists(db, eventId);
  if (!ACTIVE_STATUSES.includes(ev.status)) throw conflict(`事件已处于终态(${ev.status}),不可记录进度`);
  const info = db.prepare(
    'INSERT INTO emergency_progress_log (event_id, action, actor_id, detail) VALUES (?,?,?,?)'
  ).run(eventId, action, actor?.employee_id || null, detail || null);
  db.transaction(() => {
    recordEvent(db, { ref_type: 'emergency', ref_id: String(eventId), event: 'progress_report', actor_id: actor?.employee_id || 0, actor_role: actor?.actor_role || '', payload: { action, detail } });
  })();
  return db.prepare('SELECT * FROM emergency_progress_log WHERE id = ?').get(Number(info.lastInsertRowid));
}

// ---- 结案(带复盘摘要)----
function resolveEvent(db, eventId, summary, actor) {
  const ev = assertEventExists(db, eventId);
  if (ev.status !== 'executing') throw badRequest('仅执行中(executing)的事件可结案');
  db.transaction(() => {
    db.prepare(
      `UPDATE emergency_event SET status = 'resolved', end_time = CURRENT_TIMESTAMP, summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(JSON.stringify(summary || {}), eventId);
    db.prepare('INSERT INTO emergency_progress_log (event_id, action, actor_id, detail) VALUES (?,?,?,?)').run(eventId, '结案', actor?.employee_id || null, summary?.note || null);
    recordEvent(db, { ref_type: 'emergency', ref_id: String(eventId), event: 'event_resolved', actor_id: actor?.employee_id || 0, actor_role: actor?.actor_role || '', payload: { summary } });
  })();
  return getEvent(db, eventId);
}

// ---- 战报引擎 ----
// 聚合事件 + 调度 + 进度日志 + 态势,生成 content(Markdown) + data_json(结构化)。幂等。
function generateBattleReport(db, eventId, actor) {
  const ev = assertEventExists(db, eventId);
  const dispatches = db.prepare('SELECT * FROM emergency_dispatch WHERE event_id = ? ORDER BY id').all(eventId);
  const logs = db.prepare('SELECT * FROM emergency_progress_log WHERE event_id = ? ORDER BY id').all(eventId);
  const situation = _parseJson(ev.situation, {});
  const summary = _parseJson(ev.summary, {});

  const personnel = dispatches.filter(d => d.resource_type === 'personnel').map(d => ({ name: d.resource_name, role: d.assigned_role, area: d.area }));
  const vehicles = dispatches.filter(d => d.resource_type === 'vehicle').map(d => ({ name: d.resource_name, source: d.source, area: d.area }));
  const materials = dispatches.filter(d => d.resource_type === 'material').map(d => ({ name: d.resource_name, source: d.source }));

  const roadsAffected = situation.roads_affected || [];
  const roadsCleared = situation.roads_cleared || summary.roads_cleared || [];

  const startMs = ev.start_time ? new Date(ev.start_time).getTime() : 0;
  const endMs = ev.end_time ? new Date(ev.end_time).getTime() : 0;
  const durationMinutes = (ev.end_time && startMs && endMs > startMs) ? Math.round((endMs - startMs) / 60000) : null;

  const commanderName = ev.commander_id
    ? (db.prepare('SELECT name FROM employees WHERE employee_id = ?').get(ev.commander_id)?.name || null)
    : null;
  const deputyName = ev.deputy_commander_id
    ? (db.prepare('SELECT name FROM employees WHERE employee_id = ?').get(ev.deputy_commander_id)?.name || null)
    : null;

  const data = {
    title: ev.title,
    category: ev.category,
    level: ev.level,
    status: ev.status,
    start_time: ev.start_time,
    end_time: ev.end_time,
    duration_minutes: durationMinutes,
    commander: commanderName,
    deputy_commander: deputyName,
    personnel,
    vehicles,
    materials,
    roads_affected: roadsAffected,
    roads_cleared: roadsCleared,
    progress_events: logs.length,
    summary,
  };

  const content = renderBattleReportMarkdown(data);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO emergency_battle_report (event_id, content, data_json, format, generated_by)
       VALUES (?,?,?, 'markdown', ?)
       ON CONFLICT(event_id) DO UPDATE SET content = excluded.content,
         data_json = excluded.data_json, generated_at = CURRENT_TIMESTAMP, generated_by = excluded.generated_by`
    ).run(eventId, content, JSON.stringify(data), actor?.employee_id || null);
    recordEvent(db, { ref_type: 'emergency', ref_id: String(eventId), event: 'battle_report', actor_id: actor?.employee_id || 0, actor_role: actor?.actor_role || '', payload: { title: ev.title, level: ev.level, personnel: personnel.length, vehicles: vehicles.length, materials: materials.length } });
  })();

  return db.prepare('SELECT * FROM emergency_battle_report WHERE event_id = ?').get(eventId);
}

function renderBattleReportMarkdown(d) {
  const lines = [];
  lines.push(`# 清雪应急战报 · ${d.title}`);
  lines.push('');
  lines.push(`- **事件类别**:${d.category}`);
  lines.push(`- **应急等级**:${d.level}`);
  lines.push(`- **状态**:${d.status}`);
  lines.push(`- **启动时间**:${d.start_time || '-'}`);
  lines.push(`- **结束时间**:${d.end_time || '-'}`);
  lines.push(`- **持续时间**:${d.duration_minutes != null ? d.duration_minutes + ' 分钟' : '进行中'}`);
  lines.push(`- **指挥**:${d.commander || '-'}`);
  lines.push(`- **副指挥**:${d.deputy_commander || '-'}`);
  lines.push('');
  lines.push('## 投入人员');
  lines.push(d.personnel.length ? d.personnel.map(p => `- ${p.name}${p.role ? `(${p.role})` : ''}${p.area ? ` · ${p.area}` : ''}`).join('\n') : '- (无)');
  lines.push('');
  lines.push('## 投入车辆');
  lines.push(d.vehicles.length ? d.vehicles.map(v => `- ${v.name}(${v.source === 'own' ? '自有' : '外租'})${v.area ? ` · ${v.area}` : ''}`).join('\n') : '- (无)');
  lines.push('');
  lines.push('## 投入物资');
  lines.push(d.materials.length ? d.materials.map(m => `- ${m.name}(${m.source === 'own' ? '自有' : '外租'})`).join('\n') : '- (无)');
  lines.push('');
  lines.push('## 路段');
  lines.push(`- **受影响**:${d.roads_affected.length ? d.roads_affected.join('、') : '无'}`);
  lines.push(`- **已清理**:${d.roads_cleared.length ? d.roads_cleared.join('、') : '无'}`);
  lines.push('');
  lines.push(`## 进度记录(${d.progress_events} 条)`);
  lines.push('- 详见系统进度日志。');
  return lines.join('\n');
}

// ---- 查询辅助 ----
function listEvents(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.category) { where.push('category = ?'); params.push(filters.category); }
  const sql = `SELECT e.*, p.name AS plan_name FROM emergency_event e
                 LEFT JOIN emergency_plan p ON p.id = e.plan_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY e.id DESC`;
  return db.prepare(sql).all(...params);
}

function getEventDetail(db, eventId) {
  const ev = assertEventExists(db, eventId);
  const dispatches = db.prepare('SELECT * FROM emergency_dispatch WHERE event_id = ? ORDER BY id').all(eventId);
  const logs = db.prepare('SELECT * FROM emergency_progress_log WHERE event_id = ? ORDER BY id').all(eventId);
  const plan = db.prepare('SELECT * FROM emergency_plan WHERE id = ?').get(ev.plan_id);
  const battle = db.prepare('SELECT * FROM emergency_battle_report WHERE event_id = ?').get(eventId);
  return { event: ev, plan, dispatches, logs, battle_report: battle };
}

function listResources(db) {
  const own = db.prepare(
    `SELECT id, name, spec, category, unit, stock, location FROM inventory_item WHERE is_rented = 0 ORDER BY name`
  ).all();
  const rented = db.prepare(
    `SELECT ri.id AS rental_item_id, ri.serial_no, ri.status, ri.day_rate, i.id AS item_id, i.name, i.spec, i.category
       FROM rental_item ri JOIN inventory_item i ON i.id = ri.item_id
      WHERE ri.status = 'rented' ORDER BY i.name`
  ).all();
  const personnel = db.prepare(
    `SELECT employee_id, name, position, department, team_id FROM employees WHERE is_active = 1 ORDER BY name`
  ).all();
  return { own, rented, personnel };
}

module.exports = {
  STATE_TRANSITIONS, EVENT_TYPE_FOR_TARGET, ACTIVE_STATUSES,
  ApiError, badRequest, notFound, conflict,
  createEvent, transition, dispatch, addProgressLog, resolveEvent, generateBattleReport,
  listEvents, getEventDetail, listResources, assertTransition, getEvent,
  verifyChain,
};
