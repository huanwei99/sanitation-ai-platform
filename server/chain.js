// chain.js — 审计链哈希核心(DR-T06)
// 单一实现:recordEvent 写链 + verifyChain 校验链。distribution.js 与 audit.js 共用,避免算法漂移。
// 稳定字段:排除 occurred_at/captured_at(SQLite 往返会变形导致重算不匹配),字段顺序固定。

const crypto = require('node:crypto');

// 取某 ref 链的当前头哈希(空链返回 '')
function prevHash(db, refType, refId) {
  const row = db.prepare(
    `SELECT event_hash FROM chain_event WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC LIMIT 1`
  ).get(refType, refId);
  return row ? row.event_hash : '';
}

// 追加一条链事件并返回(含 event_hash)
function recordEvent(db, { ref_type, ref_id, step_no = null, event, actor_id, actor_role = '', payload = {}, captured_at = null }) {
  const prev = prevHash(db, ref_type, ref_id);
  const occurredAt = new Date().toISOString();
  const hashSource = { ref_type, ref_id, step_no, event, actor_id, actor_role, payload, prev };
  const event_hash = crypto.createHash('sha256')
    .update(JSON.stringify(hashSource))
    .digest('hex');
  db.prepare(
    `INSERT INTO chain_event (ref_type, ref_id, step_no, event, actor_id, actor_role, payload, occurred_at, captured_at, prev_event_hash, event_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(ref_type, ref_id, step_no, event, actor_id, actor_role,
        JSON.stringify(payload), occurredAt, captured_at, prev, event_hash);
  return { ref_type, ref_id, step_no, event, actor_id, actor_role, payload, occurred_at: occurredAt, prev_event_hash: prev, event_hash };
}

// 用稳定字段集重算单条 event_hash
function computeHash(evRow, prev) {
  let payloadObj;
  try { payloadObj = JSON.parse(evRow.payload || '{}'); } catch { payloadObj = evRow.payload; }
  const hashSource = {
    ref_type: evRow.ref_type, ref_id: evRow.ref_id, step_no: evRow.step_no,
    event: evRow.event, actor_id: evRow.actor_id, actor_role: evRow.actor_role,
    payload: payloadObj, prev
  };
  return crypto.createHash('sha256').update(JSON.stringify(hashSource)).digest('hex');
}

// 校验某条链(单 ref):prev 串联 + 每条 event_hash 重算
function verifyChain(db, refType, refId) {
  const events = db.prepare(
    `SELECT * FROM chain_event WHERE ref_type = ? AND ref_id = ? ORDER BY id`
  ).all(refType, refId);
  let prev = '';
  for (const ev of events) {
    if (ev.prev_event_hash !== prev) {
      return { ok: false, broken_at: ev.id, reason: 'prev_hash 不匹配(链断裂)' };
    }
    const expect = computeHash(ev, prev);
    if (expect !== ev.event_hash) {
      return { ok: false, broken_at: ev.id, reason: 'event_hash 不匹配(事件被篡改)' };
    }
    prev = ev.event_hash;
  }
  return { ok: true, events: events.length, head: prev };
}

module.exports = { recordEvent, verifyChain, computeHash, prevHash };