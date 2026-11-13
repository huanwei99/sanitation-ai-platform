# Phase-0 基础 + 子系统A 可执行骨架

这是平台审计后落地的第一块「可运行」资产：把 [SUBSYSTEM-A-MATERIALS-SPEC.md](../SUBSYSTEM-A-MATERIALS-SPEC.md) 里的验收标准 A-T1…A-T12 变成**能跑的测试**，并附上 Phase-0 的**建库迁移 SQL**。

## 目录
```
foundation/
├── migrations/
│   └── 001_init.sql          # Phase-0 + 子系统A 建库脚本（SQLite/可平移 Postgres）
└── tests/
    ├── engine.js             # 领域引擎（内存仓库层，复刻 SQL 不变量）
    └── engine.test.js        # A-T1…A-T12 验收测试（node:test，零依赖）
```

## 运行测试
```bash
cd foundation
node --test tests/engine.test.js
```
无需 `npm install`——只用 Node 内置 `node:test` + `node:crypto`。（当前 Node v24 已验证通过：12 pass / 0 fail）

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

## 尚需你决策的开放项（见规格 §10）
1. 审批是否强制前置（当前默认 `distribution.require_approval=true`，在 `org_policy` 表可配）
2. 一线是否有手机+账号（A-T5 的 self-only 依赖此；否则需仓库平板「按人 PIN」兜底）
3. 单仓 vs 多仓（当前单仓；多仓需给 `inventory_item` 加 `location_id`）
4. 目标客群与付费意愿（整个立项最大的未验证假设，需 2–3 家真实项目公司访谈）
5. 路线图负责人（统一路线图目前只锚定依赖，未锚定日期，就等这个）
