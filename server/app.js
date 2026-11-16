// DR-T01 — Fastify 服务骨架
// 范围:仅 /healthz + 静态文件托管代理说明;
// 后续 T02(SQLite)/T03(auth) 在此 app 基础上扩展。

const path = require('node:path');
const fs = require('node:fs');
const { initDb } = require('./db');
const { registerAuthRoutes } = require('./auth');
const { registerDistributionRoutes } = require('./distribution');
const { registerAuditRoutes } = require('./audit');
const { registerOrgPolicyRoutes } = require('./org-policy-routes');
const { registerOutboxRoutes } = require('./outbox');
const { registerDepotTransferRoutes } = require('./depot-transfer');
const { registerSeedImportRoutes } = require('./seed-import');
const { registerRequisitionRoutes } = require('./requisition');
const { registerReportRoutes } = require('./reports');

async function buildApp(opts = {}) {
  let fastify;
  try {
    fastify = require('fastify')(opts);
  } catch (e) {
    // fastify 未安装时的降级提示
    console.error('[app] fastify 未安装,请先运行: cd server && npm install');
    throw e;
  }

  // ---- 数据层(DR-T02):打开 SQLite + 跑迁移 ----
  // 默认文件库落 server/data/warehouse.db;测试可注入 dbPath / db。
  const dbPath = opts.dbPath || process.env.DB_PATH
    || path.join(__dirname, 'data', 'warehouse.db');
  let dbInfo = null;
  if (opts.db) {
    // 已有连接(测试注入)
    dbInfo = { db: opts.db, migrations: [] };
  } else {
    try {
      dbInfo = initDb(dbPath);
      fastify.log.info(
        { dbPath, migrations: dbInfo.migrations },
        '[app] 数据库已初始化'
      );
    } catch (e) {
      fastify.log.error(e, '[app] 数据库初始化失败(better-sqlite3 未安装?)');
      // 不抛:让 /healthz 仍可探活,但标注 db 未就绪
    }
  }
  fastify.decorate('db', dbInfo ? dbInfo.db : null);

  // ---- 健康检查(验收标准:healthz 返回 200) ----
  // C-3: db 不可用时 status 改 'degraded',让探活脚本区分正常与降级
  fastify.get('/healthz', async (_req, reply) => {
    const dbOk = !!fastify.db;
    if (!dbOk) reply.code(503);
    return {
      status: dbOk ? 'ok' : 'degraded',
      service: 'sanitation-platform',
      version: '0.1.0',
      db: dbOk ? 'ready' : 'unavailable',
      uptime_s: Math.round(process.uptime()),
      ts: new Date().toISOString()
    };
  });

  // ---- 认证路由(DR-T03):login/logout/me/change-password ----
  // 失败时(如 cookie 插件缺失)抛错;测试可直接注入 cookieSecret。
  await registerAuthRoutes(fastify, {
    cookieSecret: opts.cookieSecret || process.env.COOKIE_SECRET
  });

  // ---- 发放链路由(DR-T04):依赖 auth 的 authenticate 装饰器 ----
  await registerDistributionRoutes(fastify);

  // ---- 领取链路由(P1-T01):2步流程,复用 authenticate 装饰器 ----
  await registerRequisitionRoutes(fastify);

  // ---- 审计链查询/校验(DR-T06):A-T10 ----
  await registerAuditRoutes(fastify);

  // ---- org_policy 管理(P0-T02):策略即时生效,无需重启 ----
  await registerOrgPolicyRoutes(fastify);

  // ---- 离线 outbox 重放(P0-T03):断网操作联网后批量回放,幂等去重 ----
  await registerOutboxRoutes(fastify);

  // ---- 仓间调拨(P0-T04):移出+移入两步,各记流水 ----
  await registerDepotTransferRoutes(fastify);

  // ---- seed 导入(P0-T07):物料/员工/仓库批量导入,幂等 ----
  await registerSeedImportRoutes(fastify);

  // ---- 报表(P1-T04):流水/低库存/发放统计 ----
  await registerReportRoutes(fastify);

  // ---- 静态文件托管(同源方案,替代后续 Caddy 直接 serve) ----
  // Phase-0 架构要求:生产环境由 Caddy 托管静态文件,
  // 开发阶段由 Fastify 直接 serve 供本地调试。
  // 依赖 @fastify/static,若未安装则跳过,不影响 /healthz。
  const staticRoot = path.resolve(__dirname, '..');
  const hasStaticPlugin = (() => {
    try { require.resolve('@fastify/static'); return true; }
    catch { return false; }
  })();

  if (hasStaticPlugin) {
    const fastifyStatic = require('@fastify/static');
    await fastify.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      decorateReply: true
    });
  } else {
    fastify.log.info(
      '[app] @fastify/static 未安装,跳过静态托管(生产环境由 Caddy 处理)'
    );
  }

  // ---- 404 兜底(仅对 /api/* 返回 JSON,其余由静态层处理) ----
  // C-3: index.html 启动时读一次缓存,避免每次 404 都同步 readFileSync
  const indexPath = path.join(staticRoot, 'index.html');
  let indexHtmlCache = null;
  if (fs.existsSync(indexPath)) {
    indexHtmlCache = fs.readFileSync(indexPath);
  }
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({
        error: 'not_found',
        path: req.url,
        message: 'API 路由尚未注册(后续 DR-T02/T03/T04 扩展)'
      });
    }
    // 非 API 路径尝试返回 index.html(SPA fallback)
    if (indexHtmlCache) {
      return reply.type('text/html').send(indexHtmlCache);
    }
    reply.code(404).send('Not Found');
  });

  // ---- 关闭钩子:释放 SQLite 连接(Windows 上否则删库文件会 EBUSY) ----
  fastify.addHook('onClose', async (instance) => {
    try {
      if (instance.db && typeof instance.db.close === 'function') {
        instance.db.close();
      }
    } catch (e) {
      instance.log.warn(e, '[app] 关闭 db 连接时出错(可能已关闭)');
    }
  });

  return fastify;
}

module.exports = { buildApp };
