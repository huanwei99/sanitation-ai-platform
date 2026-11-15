# DR 冲刺包代码审查清单

v1.1 · 2026-11-15 · 审查对象：`e6094b5 实现 Dry-Run 冲刺包 DR-T01~T08`（server/、Caddyfile、migrations 003/004、ci.yml、DRILL-SCRIPT.md）

## 实施状态（2026-11-15 更新）

| 项 | 状态 |
|---|---|
| A-1 ~ A-4 | ✅ **已修并提交**（`66d8ce7`） |
| B-1、B-2 | ✅ **已修并提交**（`66d8ce7`） |
| C-1、C-3 | ✅ **已修**（工作区待提交） |
| 文档过期 | ✅ **已修**（本文档、DRILL-SCRIPT、server/README） |
| C-2 | ⏳ 待定，需 Daniel 拍板 |

已修内容速览：
- A/B 级（提交 `66d8ce7`）：Caddyfile 静态根改 `.`；审批加 `canApprove`（admin_level≥1 或发放 approve 权）；签收统一为"必须在接收人池且状态已移交"（堵假成功）；库存预检并入事务并统一 409 口径；/audit/* 接线 `canViewAudit`（低权限仅看本人事件）；链查询限"申请人/接收人/有发放权"。
- C 级（工作区待提交）：
  - **C-1** 单号生成改 `MAX(序号)+1`（防删/回滚撞号）
  - **C-3** healthz db 不可用时改 `degraded` + 503；404 页面启动时缓存；engines 收紧到 `>=22.5`

**验证状态：✅ 已验证全绿（2026-11-15）**

- 本机 Node v22.23.5（`AppData/Local/Programs/nodejs`，满足 22.5+ 的 node:sqlite 要求）
- `server` 套：**31 pass / 0 fail** —— 原 27 项 + 新增 4 项回归覆盖（[server/regression-ab.test.js](server/regression-ab.test.js)：A-2 无权审批 403、A-3 申请人不在池签收 403、B-1 审计限权、B-2 链查询限权）
- `foundation` 套：**22 pass / 0 fail**（内存版 A-T1..A-T13 + SQL 版，无回退）
- 复现命令：`cd server && npm test`；`cd foundation && node --test tests/engine.test.js tests/sql.test.js`

预期影响已落实：现有 27 项全绿不回退；新增权限分支由回归测试覆盖。

---

## A 级：正确性 bug（✅ 已修）

> 以下行号为审查时（e6094b5）的行号，实施后略有位移；以 git diff 为准。


### A-1 · Caddyfile 静态根路径错误
- 位置：`Caddyfile:25`(`root * ../`)
- 现象：Caddyfile 位于仓库根，`../` 指向仓库**父目录**(D:\workspace\)，try_files 找不到 index.html/js/css，静态页全部 404。
- 影响：DR-T01 验收标准"经 Caddy 访问页面与 API 正常"直接过不了；API(/api/*、/healthz)反代不受影响。
- 修法：`root * .`
- 验证：`caddy run --config Caddyfile` 后访问 :8790 应出 index.html。

### A-2 · 审批无权限校验
- 位置：`server/distribution.js:132`(approveDistribution)
- 现象：审批路由只做了登录鉴权(authenticate)与自审拦截，**没有校验审批人权限**；注释声明"审批人需在审批白名单或 admin_level≥1"但未落码。任何登录账号(含一线保洁员 EMP5003)都能 approve。
- 影响：审批虽强制前置(未批不能出库)，但审批人不受控 —— G3(审批可绕过)的变体。
- 修法：新增 `canApprove(db, employeeId)`：admin_level≥1 或 modules.distribution 含 approve/ALL；不满足 403。
- 测试影响：现有测试审批人 EMP2002/EMP5002 均为 admin_level=1,可通过；保洁员审批会变 403(目前无此测试)。

### A-3 · 签收存在"假成功"路径
- 位置：`server/distribution.js:355-392`(receiveDistribution)
- 现象：self_only 策略下，若 `principal.employee_id === dist.applicant_id` 直接放行；随后 `rec` 查 recepient 池，若申请人不在池里则 `rec==null` —— 事务内 `if(rec)` 不执行、**不更新任何接收人行**，却照写 signoff 链事件并返回 `ok:true`。幂等键已写入，重放还是同样的假成功。
- 影响：申请人即非接收人时，签收"成功"但无任何状态变化，链上却留了签收记录 —— 审计链与业务状态不一致(正冲着审计链卖点来的，伤)。
- 现有测试为何没发现：fixture 里 applicant_id=2003/5003 同时也在 recipients 列表，掩盖了该分支。
- 修法：统一口径 —— 签收人必须在 recipient 池中且状态为"已移交"才可签；不在池 403，状态不对 400。去掉 applicant 特权分支(或保留 applicant 但要求其同时在池中)。
- 测试影响：现有 4 个签收测试(applicant 均在池)可通过；需补"申请人不在池"用例。

### A-4 · 库存预检在事务外
- 位置：`server/distribution.js:194-203`(issueDistribution 预检循环)
- 现象：预检(SELECT stock)在 `app.db.transaction(...)` 之外执行。事务内有 `WHERE id=? AND stock>=?` 双保险防超扣，但若预检通过后、事务执行前库存被改动，事务内扣减失败会抛错走 catch 返回 **400** 而非 A-T2 要求的 409 + available/requested。
- 影响：单进程串行写(SQLite WAL + better-sqlite3/node:sqlite 同步)下不会触发，属并发隐患；但失败码口径与 A-T2 不一致。
- 修法：把预检搬进事务开头，409 响应从事务内抛特定错误(如 `new InsufficientStock(...)`) 统一捕获。

---

## B 级：安全/一致性（✅ 已修）

### B-1 · canViewAudit 定义了从未调用
- 位置：`server/audit.js:10-14`
- 现象：`canViewAudit`(admin_level≥1 或 level≥3)写好了，但 `/audit/events`、`/audit/chain`、`/audit/verify-all` 三个路由都没调用 —— 注释写"MVP 阶段有登录即放行"。任何登录用户可拉全量审计事件(含他人签收 payload)。
- 修法：二选一 —— ①接线：满足 canViewAudit 看全量，否则仅返回 `actor_id = me` 的事件；②若决定 DR 阶段就是"登录即放行"，删掉死代码并改注释，别留误导。
- 建议：选①。审计链是干跑演练的核心展示点，口径不清当场会被问。

### B-2 · 链查询无权限限制
- 位置：`server/distribution.js:441`(`GET /distribution/:id/chain`)
- 现象：任何登录用户可校验/查看任意单据的哈希链。
- 修法：与 B-1 同批定口径 —— 至少限"本人相关单据或 canDistribute/canViewAudit"。

---

## C 级：健壮性/小问题（可延后，不挡演练）

### C-1 · 单号生成可能重号
- 位置：`server/distribution.js:70-71`
- 现象：`MD-{year}-{COUNT(*)+1}`，COUNT 不含已删除/失败的记录，并发或创建事务回滚后可能撞号。
- 修法（低优先）：取 `MAX(序号)+1`，或 INSERT OR IGNORE + 重试。

### C-2 · 改密策略与锁定解锁
- 位置：`server/auth.js:206`(change-password)
- 现象：①未禁止新旧密码相同（仅查长度≥8、不等于默认密码）；②5 次锁定后**无解锁端点**，演练中锁死只能手动改库 —— 003 迁移注释明确"管理员解锁"，account_lock_log 也预留了 unlock 事件。
- 注意：解锁端点属**新增功能**，与 DEMAND-POOL"范围锁定本包、防蔓延"的冲刺纪律冲突，需 Daniel 拍板是否纳入。

### C-3 · healthz 与小问题
- 位置：`server/app.js:45-52`、`server/app.js:99-101`、`server/package.json:13-15`
- 现象：①healthz 恒返回 `status:'ok'`，即使 db 不可用（db 字段会标 unavailable，但 status 不变，探活脚本可能误判）；②404 兜底每次请求同步 readFileSync index.html；③engines 声明 `>=20`，但 node:sqlite 需 22.5+，装 Node 20 的同事会运行时才发现。
- 修法：①db 不可用时 status 改 'degraded'(或直接 503)；②启动时读一次缓存；③engines 收紧到 `>=22.5`。

---

## 顺带发现：文档过期（不属代码）

- `server/README.md` 目录清单缺 auth.js / distribution.js / chain.js / audit.js / seed-drill.js / migrations 003/004 等新文件，正文仍写 DR-T02="better-sqlite3"(实际优先 node:sqlite)。
- `DRILL-SCRIPT.md:30` 写"期望 27 pass"，实际测试数需在有 Node 的环境核对（本机未装 Node,未验证）。

---

## 验证说明

- 本机 **未安装 Node**，审查为纯静态、未执行任何测试；验证路径见顶部"实施状态"。
- 验收底线（DEMAND-POOL Gate-DR 第 4 条）：`node --test` 全绿 —— 内存版 A-T1..A-T13 不回退 + server 测试套全绿。
