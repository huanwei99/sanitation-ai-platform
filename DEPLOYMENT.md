# 环卫物资管理平台 — 部署手册

> 适用范围:Phase-0 / Dry-Run 试点环境(LAN 内网,纯 HTTP)
> 架构:Caddy(8790) → Fastify(8791) → SQLite(文件库)
> 目标:非运维同事也能在一台 Windows/Linux 机器上 30 分钟内跑起来。

---

## 1. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22.5** | 必须,使用内置 `node:sqlite` 模块(零编译) |
| Caddy | 2.x | 反向代理 + 静态托管(可选,纯 API 调试可省) |
| 操作系统 | Windows 10+ / Linux | 跨平台 |
| 网络 | LAN 内网 | Phase-0 不要求公网/HTTPS |
| 磁盘 | > 200MB | SQLite 文件库 + node_modules |

**关键**: 不要用 Node 20 及以下——会触发 `better-sqlite3` 编译(需要 VS Build Tools)。Node 22.5+ 自带 `node:sqlite`,纯 JS 零编译。

---

## 2. 安装步骤(Windows)

### 2.1 装 Node.js

1. 去 https://nodejs.org 下载 **22.x LTS** 安装包(选 `.msi`)
2. 安装时勾选 "Add to PATH"
3. 验证: 打开新的 PowerShell,执行 `node -v` → 应显示 `v22.x.x`

### 2.2 拉代码

```powershell
cd D:\workspace
git clone https://github.com/<用户名>/sanitation-ai-platform.git
cd sanitation-ai-platform
```

### 2.3 装依赖

```powershell
cd server
npm install
```

> 看到 `optionalDependencies` 里 `better-sqlite3` 编译失败**不用管**——只要 Node >= 22.5,服务用的是内置 `node:sqlite`。

### 2.4 配环境变量(可选)

服务启动需要一个 cookie 加密密钥。**不设也能用**(会用默认值),生产环境必须设。

PowerShell(临时,当前窗口有效):
```powershell
$env:COOKIE_SECRET = "换成一段32位以上随机字符串"
$env:PORT = "8791"
```

永久(用户级):
```powershell
[Environment]::SetEnvironmentVariable("COOKIE_SECRET", "换成随机字符串", "User")
```

### 2.5 启动服务

```powershell
# 在 sanitation-ai-platform\server 目录下
npm start
```

看到 `服务已启动 → http://0.0.0.0:8791` 即成功。

浏览器访问 http://localhost:8791/healthz → 返回 `{"status":"ok",...}` 即健康。

---

## 3. 启动 Caddy(可选,用于同源部署)

**开发/走查环境无需 Caddy**:`@fastify/static` 已纳入依赖,Fastify 在 `:8791` 直接同源托管前端页面
(`index.html` / `mobile-sign.html` / `config.html`)。试点部署推荐 Caddy 以隔离前后端;不装 Caddy 也能用全功能。

### 3.1 下载 Caddy

去 https://caddyserver.com/download 下载 Windows 版 `caddy.exe`,放到仓库根目录。

### 3.2 启动

```powershell
cd D:\workspace\sanitation-ai-platform
.\caddy.exe run --config Caddyfile
```

Caddy 监听 `:8790`,自动:
- `/api/*` → 反代到 Fastify `:8791`
- `/healthz` → 反代
- 其余 → 静态文件(`index.html`、`mobile-sign.html`、`config.html` 等)

### 3.3 验证

浏览器打开 http://localhost:8790/ → 看到首页
http://localhost:8790/healthz → 返回 200

---

## 4. 初始化数据(种子)

首次部署后,执行种子脚本灌入测试账号和物资:

```powershell
cd server
node seed-drill.js
```

输出应包含:
- 5 种物资(INV-001~INV-005)已入库(DP-001)
- 4 个账号已创建(库管员/审批人/班组长/一线),统一初始密码 `Aa@123456`

**幂等**: 重复执行不会报错,已有数据会跳过。

---

## 5. 目录结构

```
sanitation-ai-platform/
├── Caddyfile                  # Caddy 配置(8790 反代 + 静态)
├── index.html                 # 管理端首页
├── mobile-sign.html           # 移动端签收页
├── config.html                # 策略配置面板
├── server/
│   ├── server.js              # 入口(PORT=8791)
│   ├── app.js                 # 路由装配
│   ├── auth.js                # 认证 + RBAC
│   ├── distribution.js        # 发放链
│   ├── depot-transfer.js      # 仓间调拨(P0-T04)
│   ├── audit.js               # 审计链查询
│   ├── org-policy.js          # 策略服务(P0-T02)
│   ├── outbox.js              # 离线重放(P0-T03)
│   ├── chain.js               # 哈希链核心
│   ├── db.js                  # SQLite 适配层(node:sqlite)
│   ├── seed-drill.js          # 演练种子
│   ├── data/                  # SQLite 库文件(自动创建)
│   └── *.test.js              # 测试
├── foundation/
│   ├── migrations/            # SQL 迁移(001~010)
│   └── tests/                 # 内存引擎 + SQL 测试
└── .github/workflows/ci.yml   # CI
```

---

## 6. 验证清单(部署后必跑)

### 6.1 单元测试

```powershell
cd server
npm test
```

应输出 server `177` pass + foundation `22` = **199 pass / 0 fail**(2026-11-18 实测;计数随套件增长,权威以实跑 # tests 为准)。

### 6.2 健康检查

```powershell
Invoke-RestMethod http://localhost:8791/healthz
```

返回 `status: ok`。

### 6.3 演练脚本

照 [DRILL-SCRIPT.md](DRILL-SCRIPT.md) 走一遍完整发放流程(创建→审批→出库→移交→签收),确认无阻塞。

### 6.4 审计链验证

走完一次发放后:
```powershell
# 用库管员账号登录拿 cookie 后调用
Invoke-RestMethod http://localhost:8791/audit/verify-all -Headers @{Cookie=$sid}
```

返回 `all_ok: true`。

---

## 7. 生产注意事项

### 7.1 必做

- [ ] 设 `COOKIE_SECRET` 为强随机串(≥32 字符)
- [ ] 修改种子账号的默认密码 `Aa@123456`
- [ ] 限制 `:8791` 只允许 `127.0.0.1` 访问(Caddy 在前面挡着)
- [ ] 定期备份:`backup.js` + 夜间计划任务(见 §11)

### 7.2 可选

- Caddy 换域名 + 自动 HTTPS(把 `:8790` 改成 `your.domain`)
- 用 PM2/NSSM 把 `node server.js` 注册为系统服务,开机自启
- 防火墙放通 `:8790`(LAN 内访问)

### 7.3 不做

- 不把 `:8791` 直接暴露到公网(只走 Caddy)
- 不在生产环境跑 `node --watch`(用 `npm start`)
- 不删 `server/data/*.db`(删了数据全没)

---

## 8. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `better-sqlite3` 编译失败 | Node 版本 < 22.5 | 升级到 Node 22.5+,服务自动用内置 `node:sqlite` |
| 启动后 404 | 未跑迁移/库未初始化 | 删 `server/data/` 重启,迁移自动跑 |
| 登录 401 | cookie 没带上 / 跨域 | 用 Caddy 同源访问 `:8790`,不要直连 `:8791` |
| 推送代码连不上 GitHub | 网络阻断 | 配代理或等网络恢复;本地 commit 不丢 |
| 改动策略不生效 | 旧缓存 | 策略改完**即时生效**(内存缓存已失效),若仍旧值检查是否改对了键 |

---

## 9. 升级流程

```powershell
# 1. 停服务(Ctrl+C 或停 PM2)
# 2. 拉代码
git pull
# 3. 更新依赖(若 package.json 变了)
cd server
npm install
# 4. 重启
npm start
# 5. 迁移自动跑(新 .sql 文件会自动执行)
```

> SQLite 迁移是幂等的——新迁移自动跑,已跑过的跳过。不需要手动操作数据库。

---

## 10. 端口与防火墙

| 端口 | 用途 | 暴露范围 |
|---|---|---|
| 8790 | Caddy(用户入口) | LAN 内开放 |
| 8791 | Fastify(API) | 仅 `127.0.0.1`,不对外 |

Windows 防火墙放通 8790:
```powershell
New-NetFirewallRule -DisplayName "Sanitation-Platform" -Direction Inbound -LocalPort 8790 -Protocol TCP -Action Allow
```

---

## 11. 备份与恢复(P0-T05 验收项)

**脚本**:`server/backup.js`(Node 实现,Windows/Linux 通用;备份前自动 WAL checkpoint + 完整性校验)

```powershell
cd server

# 立即备份
node backup.js
# → warehouse-20261116-195358.db (220.0 KB, integrity ok),存于 server/data/backups/

# 列出备份(逐份校验完整性)
node backup.js list

# 恢复(必须先停服务!)
node backup.js restore warehouse-20261116-195358.db
```

**夜间自动备份**(Windows 计划任务,每天 02:00):
```powershell
schtasks /create /tn "SanitationNightlyBackup" /tr "node D:\workspace\sanitation-ai-platform\server\backup.js" /sc daily /st 02:00 /rl HIGHEST
```
> 路径换成实际部署路径。删除任务:`schtasks /delete /tn "SanitationNightlyBackup" /f`
> 备份默认保留最近 20 份,更旧的自动清理。

### 恢复演练(2026-11-16 实测)

| 步骤 | 结果 |
|---|---|
| 备份(WAL checkpoint + 完整性校验) | ✓ 220 KB, integrity ok |
| 停服 → 删除 `warehouse.db*` | ✓ 模拟磁盘故障 |
| 重启服务 | ✓ healthz 正常但**数据全失**(登录 401)—— 注意:healthz 通 ≠ 数据还在 |
| 停服 → `backup.js restore` → 重启 | ✓ 账号登录恢复、单据 2 条、库存终值 498/119、审计链 `verify_all=true`(2 链 18 事件)—— 与灾前完全一致 |
| 全程耗时 | **< 2 分钟** |

**结论:备份可回滚验收通过。** 建议:每月跑一次该演练;Gate 评审前必跑。
