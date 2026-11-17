// emergency-routes.js — P2-T03 清雪应急指挥调度:REST 路由
// GET  /emergency/plans                          应急预案模板列表
// GET  /emergency/events                         应急事件列表(可按 status/category 过滤)
// GET  /emergency/events/:id                     事件详情(含 调度/进度/战报)
// POST /emergency/events                         创建事件(alert 态)
// POST /emergency/events/:id/transition          状态转移
// POST /emergency/events/:id/dispatch            资源调度(自有+外租+人员)
// POST /emergency/events/:id/progress            进度记录
// POST /emergency/events/:id/resolve             结案(带复盘摘要)
// POST /emergency/events/:id/battle-report       生成战报(幂等)
// GET  /emergency/events/:id/battle-report       查看战报
// GET  /emergency/resources                      可用资源(自有+在租+人员)
// 权限:module='emergency',actions=view/edit/dispatch/resolve

const auth = require('./auth');
const emg = require('./emergency');

const ACTOR_OF = (req) => ({
  employee_id: req.principal.employee_id,
  actor_role: req.principal.position || '',
});

// 领域错误 → HTTP 状态码
function sendErr(reply, e) {
  const code = e.code || 'BAD_REQUEST';
  if (code === 'NOT_FOUND') return reply.code(404).send({ ok: false, error: e.message });
  if (code === 'CONFLICT') return reply.code(409).send({ ok: false, error: e.message });
  return reply.code(400).send({ ok: false, error: e.message });
}

async function registerEmergencyRoutes(app) {
  if (!app.db) {
    app.log.warn('[emergency] db 不可用,跳过应急路由注册');
    return;
  }
  if (!app.hasDecorator('authenticate')) {
    throw new Error('应急路由需先注册 auth');
  }

  const preAuth = { preValidation: [app.authenticate] };

  // ---- GET /emergency/plans 预案模板 ----
  app.get('/emergency/plans', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无应急查看权限' });
    }
    const rows = app.db.prepare(
      'SELECT id, name, category, icon, trigger_conditions, levels, resources, procedures, created_at FROM emergency_plan ORDER BY id'
    ).all();
    return reply.send({
      ok: true,
      items: rows.map(r => ({
        id: r.id, name: r.name, category: r.category, icon: r.icon,
        trigger_conditions: JSON.parse(r.trigger_conditions),
        levels: JSON.parse(r.levels),
        resources: JSON.parse(r.resources),
        procedures: JSON.parse(r.procedures),
        created_at: r.created_at
      }))
    });
  });

  // ---- GET /emergency/events 事件列表 ----
  app.get('/emergency/events', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无应急查看权限' });
    }
    const q = req.query || {};
    const filters = {};
    if (q.status) filters.status = q.status;
    if (q.category) filters.category = q.category;
    try {
      return reply.send({ ok: true, items: emg.listEvents(app.db, filters) });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- GET /emergency/events/:id 事件详情 ----
  app.get('/emergency/events/:id', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无应急查看权限' });
    }
    try {
      return reply.send({ ok: true, detail: emg.getEventDetail(app.db, Number(req.params.id)) });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- POST /emergency/events 创建事件 ----
  app.post('/emergency/events', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'edit', null)) {
      return reply.code(403).send({ ok: false, error: '无应急编辑权限' });
    }
    try {
      const ev = emg.createEvent(app.db, req.body || {}, ACTOR_OF(req));
      return reply.code(201).send({ ok: true, event: emg.getEvent(app.db, ev.id) });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- POST /emergency/events/:id/transition 状态转移 ----
  app.post('/emergency/events/:id/transition', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'edit', null)) {
      return reply.code(403).send({ ok: false, error: '无应急编辑权限' });
    }
    const { to, note } = req.body || {};
    if (!to) return reply.code(400).send({ ok: false, error: '需要 to(目标状态)' });
    try {
      const ev = emg.transition(app.db, Number(req.params.id), to, ACTOR_OF(req), note || '');
      return reply.send({ ok: true, event: emg.getEvent(app.db, ev.id) });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- POST /emergency/events/:id/dispatch 资源调度 ----
  app.post('/emergency/events/:id/dispatch', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'dispatch', null)) {
      return reply.code(403).send({ ok: false, error: '无应急调度权限' });
    }
    try {
      const d = emg.dispatch(app.db, Number(req.params.id), req.body || {}, ACTOR_OF(req));
      return reply.code(201).send({ ok: true, dispatch: d });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- POST /emergency/events/:id/progress 进度记录 ----
  app.post('/emergency/events/:id/progress', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'dispatch', null)) {
      return reply.code(403).send({ ok: false, error: '无应急调度权限' });
    }
    const { action, detail } = req.body || {};
    if (!action) return reply.code(400).send({ ok: false, error: '需要 action' });
    try {
      const log = emg.addProgressLog(app.db, Number(req.params.id), action, detail || '', ACTOR_OF(req));
      return reply.code(201).send({ ok: true, log });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- POST /emergency/events/:id/resolve 结案 ----
  app.post('/emergency/events/:id/resolve', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'resolve', null)) {
      return reply.code(403).send({ ok: false, error: '无应急结案权限' });
    }
    try {
      const ev = emg.resolveEvent(app.db, Number(req.params.id), (req.body || {}).summary || {}, ACTOR_OF(req));
      return reply.send({ ok: true, event: emg.getEvent(app.db, ev.id) });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- POST /emergency/events/:id/battle-report 生成战报 ----
  app.post('/emergency/events/:id/battle-report', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'resolve', null)) {
      return reply.code(403).send({ ok: false, error: '无应急结案权限' });
    }
    try {
      const r = emg.generateBattleReport(app.db, Number(req.params.id), ACTOR_OF(req));
      return reply.send({
        ok: true,
        report: {
          id: r.id, event_id: r.event_id, content: r.content,
          data_json: JSON.parse(r.data_json), format: r.format,
          generated_at: r.generated_at
        }
      });
    } catch (e) { return sendErr(reply, e); }
  });

  // ---- GET /emergency/events/:id/battle-report 查看战报 ----
  app.get('/emergency/events/:id/battle-report', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'view', null)) {
      return reply.code(403).send({ ok: false, error: '无应急查看权限' });
    }
    const row = app.db.prepare('SELECT * FROM emergency_battle_report WHERE event_id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ ok: false, error: '战报尚未生成' });
    return reply.send({
      ok: true,
      report: {
        id: row.id, event_id: row.event_id, content: row.content,
        data_json: JSON.parse(row.data_json), format: row.format,
        generated_at: row.generated_at, generated_by: row.generated_by
      }
    });
  });

  // ---- GET /emergency/resources 可用资源 ----
  app.get('/emergency/resources', preAuth, async (req, reply) => {
    if (!auth.hasPermission(app.db, req.principal, 'emergency', 'dispatch', null)) {
      return reply.code(403).send({ ok: false, error: '无应急调度权限' });
    }
    return reply.send({ ok: true, resources: emg.listResources(app.db) });
  });
}

module.exports = { registerEmergencyRoutes };
