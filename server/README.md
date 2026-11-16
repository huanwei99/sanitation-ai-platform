# 服务骨架 + 数据层 — 启动与验证

DR-T01(Fastify + `/healthz` + Caddy 同源反代)+ DR-T02(SQLite WAL 数据层 + 迁移执行器,优先 `node:sqlite`,回退 better-sqlite3)。

- DR-T01 验收:**经 Caddy 访问页面与 API 正常,healthz 返回 200**
- DR-T02 验收:**空库执行迁移无错;重启服务数据保留(A-T12 SQL 版)**。

## 目录
```
server/
├── package.json        # 依赖 + 启动脚本
├── app.js              # Fastify 实例(/healthz + SQLite 数据层 + 静态托管 + 404 兜底)
├── server.js           # 入口,监听 :8791
├── db.js               # 数据层:node:sqlite(优先)/better-sqlite3 + 迁移执行器(DR-T02)
├── db.test.js          # 数据层验收测试(空库迁移 + 重启保留 + 幂等)
├── auth.js             # 认证(DR-T03):login/logout/me/change-password + 5 次锁定
├── auth.test.js        # 认证测试
├── distribution.js     # 发放链 API(DR-T04):创建/审批/出库/移交/签收/台账推进
├── distribution.test.js# 发放链测试(A-T1/T2/T3/T5)
├── chain.js            # 审计哈希链核心(DR-T06):recordEvent/verifyChain
├── audit.js            # 审计查询+校验 API(DR-T06):/audit/events|chain|verify-all
├── audit.test.js       # 审计链测试(A-T10 篡改检测)
├── mobile-sign.test.js # 移动签收测试(代签白名单 + 已完成)
├── regression-ab.test.js # A/B 级缺陷回归测试(审批鉴权/签收/审计限权)
├── seed-drill.js       # 演练种子数据(DR-T08)
├── verify.ps1          # 一键验证脚本(前置检查→安装→测试→起服务→探活)
└── README.md
Caddyfile               # 同源反代:静态页 + /api/* 与 /healthz → :8791
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
- 需 Node ≥22.5(用内置 `node:sqlite`,零编译);Caddy 为可选同源反代。代码在装有 Node 22.5+ 的机器上按上两节验证(本机已验证 31 pass)。

## 数据层说明(DR-T02)
- 库文件默认 `server/data/warehouse.db`(WAL 模式),可用 `DB_PATH` 环境变量覆盖。
- 迁移执行器**原样**跑 `foundation/migrations/` 下所有 `.sql`(001_init + 002_multi_depot + 003_auth_lockout + 004_distribution_seed),不复制 SQL。
- 迁移幂等:`user_version` 记录已应用编号,重启只补跑未应用的。
- 测试:`cd server && node --test`(优先 node:sqlite,Node<22.5 才需 better-sqlite3)。

## 下一步
- ~~DR-T03 auth~~ ✅、~~DR-T04 发放链~~ ✅、~~DR-T06 审计链~~ ✅、~~DR-T08 演练~~ ✅ 已完成。
- 剩余 C 级:C-2(改密禁新旧相同 + 锁定解锁端点)待拍板。
