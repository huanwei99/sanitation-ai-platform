# DR-T08 半天演练脚本（D-2）

**目标**：一名非开发同事在半天内照此脚本走完全程，验证发放→签收→审计闭环。

**前置**：已装有 Node 22.5+、Caddy（可选），项目目录已 clone。

---

## 0. 环境准备（约 15 分钟）

### 0.1 检查 Node
```powershell
node -v
# 应显示 v22.x.x，若 < 22.5 需升级 Node.js
```

### 0.2 安装依赖
```powershell
cd d:\workspace\sanitation-ai-platform\server
npm install
```

### 0.3 跑测试（确认代码正常）
```powershell
node --test
# 期望: 27 pass / 0 fail
```

### 0.4 灌入演练种子数据
```powershell
node seed-drill.js
```
应输出 5 种物资库存和 4 个演练账号，末尾显示"完成"。

### 0.5 启动服务
```powershell
npm start
```
终端应显示 `Server listening at http://0.0.0.0:8791`。**保持此终端不关**。

---

## 1. 备料确认（约 10 分钟）

打开浏览器，访问 `http://localhost:8791/healthz`，确认返回 JSON 且 `"db":"ready"`。

---

## 2. 发放流程（约 30 分钟）

### 2.1 登录库管员
打开 `http://localhost:8791/mobile-sign.html`，用以下账号登录：
- 工号：`DRILL-KEEPER`
- 密码：`Aa@123456`

登录成功后应看到"待签收"页面（暂无待办）。

### 2.2 创建发放单（需 API 工具或网页版）
> 说明：当前最小页只有签收功能，创建单据需通过 API。可使用以下任一方式：
> - 用 curl / Postman / 浏览器插件
> - 或让开发同事提前通过网页版创建

**方式：PowerShell + Invoke-WebRequest**

先登录库管员拿 cookie：
```powershell
$r = Invoke-WebRequest -Uri "http://localhost:8791/auth/login" -Method POST -ContentType "application/json" -Body '{"account":"DRILL-KEEPER","password":"Aa@123456"}' -SessionVariable s
$s
```
再创建发放单（给班组长 DRILL-LEADER + 一线 DRILL-WORKER，每人 1 包口罩）：
```powershell
$guid = [guid]::NewGuid().ToString()
Invoke-WebRequest -Uri "http://localhost:8791/distribution/requests" -Method POST -WebSession $s -ContentType "application/json" -Headers @{ "Idempotency-Key" = $guid } -Body '{"applicant_id":9003,"total_people":2,"depot_id":"DP-001","items":[{"item_id":"INV-001","per_person_qty":1}],"recipients":[{"employee_id":9003,"units":"A班","people_count":1},{"employee_id":9004,"units":"B班","people_count":1}]}'
```
记录返回的 `id`（形如 `MD-2026-0001`）。

### 2.3 审批
```powershell
# 先登录审批人
$r2 = Invoke-WebRequest -Uri "http://localhost:8791/auth/login" -Method POST -ContentType "application/json" -Body '{"account":"DRILL-APPROVER","password":"Aa@123456"}' -SessionVariable s2
# 审批通过（把 MD-2026-0001 换成上一步拿到的 id）
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/approve" -Method POST -WebSession $s2
```

### 2.4 出库
```powershell
# 回到库管员 session
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/issue" -Method POST -WebSession $s
```

### 2.5 班组移交（分别移交给两位接收人）
```powershell
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/transfer" -Method POST -WebSession $s -ContentType "application/json" -Body '{"recipient_id":9003}'
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/transfer" -Method POST -WebSession $s -ContentType "application/json" -Body '{"recipient_id":9004}'
```

---

## 3. 移动签收（约 20 分钟）

### 3.1 班组长张（DRILL-LEADER）签收
在浏览器（或手机同网段访问）打开 `http://localhost:8791/mobile-sign.html`：

1. **先退出**当前账号（DRILL-KEEPER）
2. 用 `DRILL-LEADER / Aa@123456` 登录
3. 应看到待签收单据（MD-2026-0001）
4. 点击"确认签收" → 提示"签收成功"，待办列表清空

### 3.2 一线员工刘（DRILL-WORKER）签收
1. 退出，换 `DRILL-WORKER / Aa@123456` 登录
2. 同样签收 MD-2026-0001

### 3.3 验证 self-only（非本人签收 403）
1. 用库管员 DRILL-KEEPER 登录 mobile-sign.html
2. 手动访问 `http://localhost:8791/distribution/MD-2026-0001/receive`（浏览器地址栏直接敲回车）
3. 应返回 `403` JSON `{"ok":false,"error":"self_only:..."}`

---

## 4. 台账确认（约 5 分钟）

回到库管员 DRILL-KEEPER 的 API session，推进 step2→3→4：
```powershell
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/advance" -Method POST -WebSession $s -ContentType "application/json" -Body '{"step":2}'
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/advance" -Method POST -WebSession $s -ContentType "application/json" -Body '{"step":3}'
Invoke-WebRequest -Uri "http://localhost:8791/distribution/MD-2026-0001/advance" -Method POST -WebSession $s -ContentType "application/json" -Body '{"step":4}'
```
最后一步返回 `"status":"已完成"`。

---

## 5. 审计链验证（约 10 分钟）

### 5.1 查询审计事件
```powershell
# 用审批人 session
Invoke-WebRequest -Uri "http://localhost:8791/audit/events?ref_type=distribution&ref_id=MD-2026-0001" -WebSession $s2 | Select-Object -ExpandProperty Content
```
应看到 8 条有序事件，每条 `prev_event_hash` = 前一条 `event_hash`。

### 5.2 校验链完整性
```powershell
Invoke-WebRequest -Uri "http://localhost:8791/audit/chain?ref_type=distribution&ref_id=MD-2026-0001" -WebSession $s2 | Select-Object -ExpandProperty Content
```
应看到 `"verify_ok":true`。

---

## 6. 复盘检查清单

- [ ] 库存正确扣减（口罩 500→498，因 2 人各 1 包）
- [ ] 流水正确写入（`stock_movement` 表有 2 条 `distribution_out`）
- [ ] 班组长张和一线员工刘各自成功签收（self-only）
- [ ] 非本人签收返回 403
- [ ] 全流程推进到"已完成"
- [ ] 审计链 8 条事件哈希串联完整，`verify_ok=true`
- [ ] 全程无阻塞，非开发同事能独立操作

---

## 演练后清理（可选）

```powershell
# 停服（Ctrl+C）
# 删演练库（下次 npm start 会重建空库）
Remove-Item d:\workspace\sanitation-ai-platform\server\data\warehouse.db*
```

---

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `node` 未识别 | PATH 未配 | 重开终端或 `refreshenv` |
| 测试失败 | 端口占用 | `npm start` 前确保 8791 未被占 |
| 创建单据返回 400 | 缺 `Idempotency-Key` | 每次创建用新 GUID |
| 签收返回 400"需先完成班组移交" | 未执行 transfer | 先走 2.5 步 |
| 签收返回 403 | 当前登录人不是接收人 | 换 DRILL-LEADER / DRILL-WORKER 登录 |
| 审计链 verify_ok=false | 库被手工改过 | 删库重建 `node seed-drill.js` |
