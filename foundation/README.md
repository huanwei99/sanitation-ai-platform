# Phase-0 基础 + 子系统A 可执行骨架

这是平台审计后落地的第一块「可运行」资产：把 [SUBSYSTEM-A-MATERIALS-SPEC.md](../SUBSYSTEM-A-MATERIALS-SPEC.md) 里的验收标准 A-T1…A-T13 变成**能跑的测试**，并附上 Phase-0 的**建库迁移 SQL**。两套测试：**内存版**（快、验证不变量逻辑）与 **SQL 版**（真 SQLite，验证迁移+事务）。

## 目录
```
foundation/
├── migrations/
│   ├── 001_init.sql          # Phase-0 + 子系统A 建库脚本（SQLite/可平移 Postgres）
│   └── 002_multi_depot.sql   # 多仓支持（决策#3：仓库主数据/库存流水挂仓/单据指定仓）
└── tests/
    ├── engine.js             # 领域引擎（内存仓库层，复刻 SQL 不变量）
    ├── engine.test.js        # 内存版 A-T1…A-T13（13 项，零依赖）
    └── sql.test.js           # SQL 版验收测试（真 SQLite 跑迁移+事务，DR-T07 交付物）
```

## 运行测试
```bash
cd foundation
node --test tests/engine.test.js   # 内存版：13 pass / 0 fail
node --test tests/sql.test.js      # SQL 版： 9 pass / 0 fail
```
无需 `npm install`——只用 Node 内置 `node:test` + `node:crypto` + `node:sqlite`。（Node v24 已验证）

**`sql.test.js` 同时是 DR-T04 / DR-T06 的 SQL 参考实现**：`withTx` / `deductOnce`（校验+扣减+流水同事务）/ `recordEvent`+`verifyChain`（哈希链）/ `withIdem`（幂等）照搬进服务端即可，别重新发明。

## 这套东西证明了什么
| 测试 | 证明的控制点 | 对应规格缺陷 |
|---|---|---|
| A-T1 | 发放 step1 事务性扣减库存 + 写流水 | **G1 库存与发放联动未接**（原型确实没扣） |
| A-T2 | 出库前校验 `qty<=stock`，不足即 409 | **G2 无库存安全门** |
| A-T3 | 无已完成审批不能生成执行链 | **G3 审批可绕过** |
| A-T4 | 分批移交 + 逐个签收 + 全签收才完成 | 四步状态机 |
| A-T5 | 仅本人可签收（非接收人代签 → FORBIDDEN） | 反舞弊审计控制 |
| A-T6 | 幂等键重放不重复扣减 | 离线重连安全 |
| A-T7 | 并发 step1 不超卖 | 并发一致性 |
| A-T8 | 领取2步同样扣库存 | **G6 领取无库存校验** |
| A-T9 | 入库质检：不合格不加库存，合格才加 | 质检门 |
| A-T10 | 审计链可校验，篡改中间事件即失败 | **G5 无防篡改审计** |
| A-T11 | 低库存（`stock<min_stock`）可查 | 安全线预警 |
| A-T12 | 单据状态可查（持久化由 Phase-0 SQLite 承担） | **G4 无持久化** |

## engine.js 与 SQL 的关系
`engine.js` 用纯 JS 实现了与 `001_init.sql` **完全一致的不变量**（库存非负、步骤只进不退、幂等、self-only、哈希链）。
落地时把这些校验搬进 SQL 事务（`applyMovement` → 一个 serializable 事务里「校验+扣减+写流水」）即可。
**先跑测试证明逻辑正确，再落到 SQL** —— 这是验证过的路径，不是凭空设计。

## 已定决策（2026-11-13，全部落码）

| # | 决策 | 结论 | 落地位置 |
|---|---|---|---|
| 1 | 审批是否强制前置 | **是**，强制 | `org_policy.distribution.require_approval='true'`（001/002 SQL）；A-T3 测试锁定 |
| 2 | 一线是否有手机+账号 | **是**，有 | `signoff.self_only='true'` 维持；A-T5 测试锁定（无需 PIN 兜底） |
| 3 | 单仓还是多仓 | **多仓** | `migrations/002_multi_depot.sql`（depot 表 + 库存/流水/单据挂仓）；引擎按仓校验隔离；**A-T13** 测试锁定（跨仓出库拒绝、仓间库存隔离、流水按仓记账） |
| 4 | 目标客群与付费 | **有付费买家，免费试用先行** | 进入执行计划的 GTM 工作流（见 ROADMAP-EXECUTION-PLAN.md：试用→转化漏斗） |
| 5 | 路线图负责人 | **Daniel** | 执行计划日期与决策点归 Daniel 拍板（见 ROADMAP-EXECUTION-PLAN.md） |

测试基线：`node --test tests/engine.test.js` → **13 pass / 0 fail**（新增 A-T13 多仓隔离）。
