// DR-T01 — 服务入口
// 启动: node server.js  (或 npm start)
// 默认监听 :8791,供 Caddy 反代或直接访问。

const { buildApp } = require('./app');

const PORT = parseInt(process.env.PORT || '8791', 10);
const HOST = process.env.HOST || '0.0.0.0';

buildApp({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: undefined // 生产环境去掉 pino-pretty
  }
}).then(async app => {
  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`服务已启动 → http://${HOST}:${PORT}`);
    app.log.info(`健康检查   → http://${HOST}:${PORT}/healthz`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
});
