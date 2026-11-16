// outbox.js — P0-T03 离线 outbox 重放
// 客户端断网时把变更操作暂存本地,联网后批量 POST /sync/outbox 重放。
// 每个子操作带 Idempotency-Key,服务端 mutating 端点已内建幂等去重,
// 故重放天然不重复;首次执行返回真实结果,后续重放返回缓存结果。
// 处理顺序:按数组顺序串行(创建→审批→出库 等有依赖的操作须保序)。

async function registerOutboxRoutes(app) {
  // POST /sync/outbox  批量重放离线操作
  app.post('/sync/outbox', {
    preValidation: [app.authenticate]
  }, async (req, reply) => {
    const ops = req.body?.operations;
    if (!Array.isArray(ops) || ops.length === 0) {
      return reply.code(400).send({ ok: false, error: '需要非空 operations 数组' });
    }
    if (ops.length > 100) {
      return reply.code(400).send({ ok: false, error: '单次重放最多 100 条操作' });
    }

    // 透传当前会话 cookie,让子操作继承登录态
    const cookieHeader = req.headers.cookie || '';
    const results = [];

    for (const op of ops) {
      const { idempotency_key, method = 'POST', path, body } = op || {};
      if (!path) {
        results.push({ idempotency_key: idempotency_key || null, status: 400, body: { ok: false, error: '缺少 path' } });
        continue;
      }
      try {
        const injectOpts = {
          method,
          url: path,
          headers: { cookie: cookieHeader },
        };
        if (idempotency_key) injectOpts.headers['idempotency-key'] = idempotency_key;
        if (body !== undefined) injectOpts.payload = body;

        const r = await app.inject(injectOpts);
        let parsed;
        try { parsed = JSON.parse(r.body); } catch { parsed = { raw: r.body }; }
        results.push({
          idempotency_key: idempotency_key || null,
          status: r.statusCode,
          body: parsed,
        });
      } catch (err) {
        results.push({
          idempotency_key: idempotency_key || null,
          status: 500,
          body: { ok: false, error: String(err.message || err) },
        });
      }
    }

    return reply.send({ ok: true, count: results.length, results });
  });
}

module.exports = { registerOutboxRoutes };
