# 服务骨架 + 数据层 — 启动与验证

DR-T01(Fastify + `/healthz` + Caddy 同源反代)+ DR-T02(better-sqlite3 WAL 数据层 + 迁移执行器)。

- DR-T01 验收:**经 Caddy 访问页面与 API 正常,healthz 返回 200**
- DR-T02 验收:**空库执行 001+002 迁移无错;重启服务数据保留(A-T12 SQL 版)**。

## 目录
```
server/
├── package.json   # 依赖 + 启动脚本
├── app.js         # Fastify 实例(/healthz + SQLite 数据层 + 静态托管)
├── server.js      # 入口,监听 :8791
├── db.js          # 数据层:node:sqlite(优先)/better-sqlite3 + 迁移执行器(DR-T02)
├── db.test.js     # 数据层验收测试(空库迁移 + 重启保留 + 幂等)
└── verify.ps1     # 一键验证脚本(前置检查→安装→测试→起服务→探活)
Caddyfile          # 同源反代:静态页 + /api/* 与 /healthz → :8791
```

## 一键验证(推荐)
```powershell
cd server
powershell -ExecutionPolicy Bypass -File verify.ps1
```
脚本依次:检查 Node ≥22.5(决定用 node:sqlite 还是 better-sqlite3)→ `npm install` → 跑数据层测试 → 起 Fastify → 探活 `/healthz` → 自动停服清理。可用 `-SkipInstall` / `-SkipService` 跳步。

## 方式一:开发模式(仅 Fastify,无 Caddy)
```powershell
cd server
npm install          # 首次:装 fastify
npm start            # 启动,监听 :8791
```
验证:
- 浏览器开 `http://localhost:8791/healthz` → JSON `{"status":"ok",...}`
- 开 `http://localhost:8791/` → 原型 index.html(需 `npm i @fastify/static`)

## 方式二:同源模式(Caddy 反代,验收标准)
前置:已安装 [Caddy](https://caddyserver.com/)。
```powershell
# 终端 1:起 Fastify
cd server; npm install; npm start     # :8791

# 终端 2:起 Caddy(在仓库根目录)
caddy run --config Caddyfile          # 监听 :8790
```
验证(全部走 Caddy :8790,体现"同源"):
- `http://localhost:8790/healthz` → 200 JSON
- `http://localhost:8790/` → 原型页
- `http://localhost:8790/api/anything` → JSON 404(API 前缀已通)

## 端口约定
| 服务 | 端口 | 说明 |
|---|---|---|
| Fastify | 8791 | 应用服务,仅本机/反代可达 |
| Caddy | 8790 | 对外同源入口(LAN) |

## 已知环境限制
- 本机当前 PATH 无 `node`/`caddy`,**代码无法在此沙箱内启动实测**。需在装有 Node 20+ 与 Caddy 的机器上按上两节验证。
- `/api/*` 目前只有 404 兜底——业务 API 在 DR-T03(auth)/T04(发放链)接入。

## 数据层说明(DR-T02)
- 库文件默认 `server/data/warehouse.db`(WAL 模式),可用 `DB_PATH` 环境变量覆盖。
- 迁移执行器**原样**跑 `foundation/migrations/001_init.sql` + `002_multi_depot.sql`,不复制 SQL。
- 迁移幂等:`user_version` 记录已应用编号,重启只补跑未应用的。
- 测试:`cd server && node --test db.test.js`(需 better-sqlite3 已安装)。

## 下一步
- DR-T03:auth(login/logout/me + bcrypt + 5 次锁定)。
- DR-T04:发放最小链 API(创建 DP-001 → 审批 → step1 事务扣减,关键路径)。
