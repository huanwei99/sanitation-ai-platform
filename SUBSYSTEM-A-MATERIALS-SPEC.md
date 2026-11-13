# Sub-system A — Materials / Warehouse / Distribution Chain

**Audit-ready chain-of-custody spec** (库管 + 物资发放 + 物料领取)

Status: Draft v0.1 · Grounded in `index.html` (rev. 2026-11-12) · Owner: TBD

This document turns Sub-system A from the platform audit into a buildable spec. It is grounded in the **actual** `index.html` code, not the docs. Where the code and the docs disagree, the code wins and the discrepancy is called out.

---

## 0. Grounding: what exists in `index.html` today

Verified entities and the `employeeId`-centric spine (all currently **in-memory JS arrays**, lost on refresh):

| Entity | Seed const | Key fields observed |
|---|---|---|
| Inventory item | `inventoryItems` | `id (INV-xxx)`, `name`, `spec`, `category (consumable/tool/spare/office)`, `unit`, `stock`, `minStock`, `location`, `lastInbound`, `cost` |
| Inbound record | `inboundRecords` | `id (IN-2026-xxx)`, `date`, `type (采购入库)`, `supplier`, `items[{inventoryId,name,spec,qty,unit,cost,totalCost}]`, `totalCost`, `operator`, `status (已完成/待质检)`, `approvalId`, `qualityCheck{inspector,result,note}` |
| Outbound record | `outboundRecords` | `id (OUT-2026-xxx)`, `date`, `type (发放出库)`, `items[{inventoryId,...,qty,unit}]`, `operator`, `receiver`, `relatedDistId`, `status` |
| Distribution | `materialDistributions` | `id (MD-2026-xxx)`, `applicantId/applicant`, `department`, `date`, `items[]`, `totalCost`, `scope (all/dept/units)`, `scopeDesc`, `perPersonItems[{name,spec,qty,unit,perPersonQty}]`, `selectedUnitIds`, `totalPeople`, `distributorId/distributor/distributorRole`, `recipients[{employeeId,name,position,department,status,receiveTime,items}]`, `workflowSteps[4]`, `approvalId`, `status`, `currentStep`, `totalSteps` |
| Requisition | `materialRequisitions` | `id (MR-2026-xxx)`, `applicantId/applicant/position`, `department`, `date`, `items[]`, `urgency`, `reqType`, `reason`, `approver`, `status`, `approvalId`, `workflowSteps[2]`, `currentStep`, `totalSteps` |
| Work unit | `workUnits` | `id`, `name`, `leaderId`, `leader`, `leaderPosition`, `dept`, `memberCount` |

Verified functions: `autoMatchRecipients()` (dedup unit leaders → recipient pool), `calcTotalFromUnits()` (per-person × headcount), `generateDistributionWorkflow()` (4 steps), `executeMatDistStep()` (advance steps 1–3), `showTransferModal()`/`confirmTransfer()` (step 3 batch transfer), `confirmReceive()`/`batchConfirmReceive()` (step 4 sign-off), `approveDistribution()`, `executeReqStep()` (2-step requisition), `approveRequisition()`.

Recipient statuses observed: `待接收` → `已移交` → `已接收`.

---

## 1. Gaps this spec closes (verified defects in current code)

These are real, not hypothetical — each was confirmed by reading the functions named:

1. **G1 — Stock is not decremented on distribution.** `executeMatDistStep()` step 1 (仓库出库) and `executeReqStep()` step 1 advance the workflow but **never touch `inventoryItems[].stock`** and never create an `outboundRecords` entry. The seeded `outboundRecords` are hand-authored. → The doc's P0 "库存与发放联动" is **unwired**. **This spec makes step 1 transactional with stock deduction + outbound-record creation.**
2. **G2 — No stock-safety gate at issue time.** Distribution quantities are computed from headcount (`calcTotalFromUnits`) but never validated against available `stock` before/out at step 1. → **Add server-side `qty <= stock` enforcement (this is also the audit control).**
3. **G3 — Approval is optional/bypassable.** `approveDistribution()` runs on `approvalId: null` (seed `MD-2026-002`), and the 4-step chain can be generated without a completed approval. → **Make a completed approval a precondition for generating the execution chain (configurable per org policy).**
4. **G4 — No persistence / no multi-user / no real auth.** All state is in-memory; login is mock (`permissions:['all']`). → Handled by **Phase 0** (below), which A depends on.
5. **G5 — No audit trail of *who* did *what* at each handoff.** Steps record a `time` string and an assignee name, but there is no immutable, user-attributed, tamper-evident event log. → **Add an append-only `chain_events` table.**
6. **G6 — Requisition has no stock check and no outbound linkage** either (same as G1/G2 for the 2-step path).
7. **G7 — No rented-equipment register (外租设备台账).** Out of scope for A v1 but noted as sibling register (Phase A3).

---

## 2. Phase 0 (prerequisite) — Foundation A depends on

A cannot be "built well" without these. Cross-device field use (保洁员/班组长签收 on a phone) is **architecturally impossible** with the current `BroadcastChannel`-only plan (same-browser-tabs only), so a server is mandatory.

- **P0.1 Persistence:** server-side DB (Postgres recommended; SQLite acceptable for single-depot pilot). Migrate the in-memory arrays to tables.
- **P0.2 AuthN/AuthZ:** real login (replace mock). RBAC with the L1–L5 role ladder from `platform-upgrade-plan.md`. Every API call carries an authenticated principal.
- **P0.3 Offline-tolerant mobile sync:** mobile client queues sign-off events locally (IndexedDB) and replays against the API when connectivity returns; server is source of truth; conflict rule = **first confirmed server write wins, later replays for the same step are idempotent no-ops** (see §5).
- **P0.4 `employeeId` spine preserved:** all transaction rows keep the `employeeId` foreign key so the existing cross-module drill-down (`employeeLink` / `showEmployeeDetail`) keeps working.

---

## 3. Data model (normalized, server-side)

Naming: snake_case columns, `employee_id` FK spine preserved from the prototype. Monetary amounts in minor units (分) to avoid float error; the prototype uses yuan floats (`cost: 2.5`) — convert.

### 3.1 `inventory_item`
```
id            text PK        -- INV-001 (keep existing codes)
name          text NOT NULL
spec          text
category      enum(consumable, tool, spare, office)
unit          text NOT NULL
stock         int NOT NULL CHECK(stock >= 0)
min_stock     int NOT NULL
location      text
unit_cost     int NOT NULL   -- 分
is_rented     bool DEFAULT false   -- reserved for 外租台账 (G7)
updated_at    timestamptz
```

### 3.2 `stock_movement` (single ledger for ALL stock changes — the audit backbone)
One row per stock delta, append-only. Replaces the need to infer stock from separate inbound/outbound tables and gives a tamper-evident trail.
```
id             bigserial PK
item_id        text FK -> inventory_item
delta          int NOT NULL            -- +in / -out
reason         enum(inbound, distribution_out, requisition_out, adjustment, return)
ref_type       enum(inbound, distribution, requisition)
ref_id         text                    -- IN-/MD-/MR- id
line_no        int                     -- item line within the doc
qty_after      int NOT NULL            -- running balance (denormalized for audit)
actor_id       int FK -> employee      -- who caused it
occurred_at    timestamptz NOT NULL
```
**Invariant:** `stock` on `inventory_item` must always equal the latest `qty_after` for that item. Enforced in the same DB transaction as the movement insert.

### 3.3 `inbound_record` (+ `inbound_line`)
```
id text PK (IN-2026-xxx), date, type, supplier, total_cost, operator_id FK,
status enum(待质检, 已完成), approval_id FK nullable,
quality_inspector_id FK nullable, quality_result enum(合格,不合格,待检), quality_note
```
On `status -> 已完成` (quality passed): insert `stock_movement(+delta, reason=inbound)` per line.

### 3.4 `distribution` (发放) (+ `distribution_line`)
```
id text PK (MD-2026-xxx)
applicant_id FK, department, requested_at
scope enum(all, dept, units), scope_desc
total_people int, total_cost int
distributor_id FK                       -- 发放人
approval_id FK                          -- see G3: NOT NULL under default policy
status enum(待审批, 已批准, 发放中, 已完成, 已取消)
current_step int, total_steps int DEFAULT 4
created_at, updated_at
```
`distribution_line`: `distribution_id FK, item_id FK, per_person_qty int, qty int (per_person_qty * total_people), unit`.

### 3.5 `distribution_recipient`
```
id bigserial PK
distribution_id FK
employee_id FK                -- unit leader, deduped (autoMatchRecipients logic)
units text[]                  -- covered unit names
people_count int
allocated_items text          -- human-readable summary (denormalized, as prototype)
status enum(待接收, 已移交, 已接收)
transferred_at timestamptz, received_at timestamptz
```

### 3.6 `requisition` (领取) (+ `requisition_line`)
```
id text PK (MR-2026-xxx), applicant_id FK, department, requested_at,
urgency enum(一般-日常补充, 较急-3日内需要, 紧急-当日需要),
req_type, reason, approver_id FK, approval_id FK,
status enum(审批中, 已批准, 发放中, 已完成, 已驳回), current_step int, total_steps int DEFAULT 2
```

### 3.7 `workflow_step` (generic, both doc types)
```
id bigserial PK
ref_type enum(distribution, requisition), ref_id text
step_no int, name text
assignee_id FK nullable
status enum(待执行, 进行中, 已完成)
started_at, completed_at, note
```

### 3.8 `chain_event` (append-only audit log — closes G5)
Every state change and every handoff writes one immutable row. **No UPDATE/DELETE ever.**
```
id bigserial PK
ref_type, ref_id, step_no nullable
event enum(approval_granted, step_started, step_completed, transfer, signoff,
           stock_deducted, cancel, edit_rejected)
actor_id FK, actor_role text
payload jsonb                 -- e.g. {recipients:[7,16], qty:{INV-001:500}}
occurred_at timestamptz
prev_event_hash text          -- hash chain for tamper-evidence
event_hash text
```

### 3.9 ID numbering
Keep the prototype's scheme: `MD-YYYY-NNN`, `MR-YYYY-NNN`, `IN-YYYY-NNN`, `OUT-YYYY-NNN`. Note: the prototype's outbound records are replaced by `stock_movement` rows with `reason=distribution_out`; keep an `OUT-` human code on those movements if the business still wants a printable outbound note.

---

## 4. State machines (server-authoritative)

### 4.1 Distribution (发放) — 4-step chain

Top-level `distribution.status`: `待审批 → 已批准 → 发放中 → 已完成` (+ `已取消`).

```
[待审批] --approve(actor=approver, approval_id completed)--> [已批准]
            generate 4 workflow_steps; step1 -> 进行中          (closes G3)

[已批准] --step1 complete(actor=仓库负责人)--> [发放中] current_step=2
            ON COMPLETE (transactional, closes G1/G2):
              for each line: assert qty <= stock  -> else 409 REJECT
              insert stock_movement(-qty, reason=distribution_out)
              create step-1 chain_event(stock_deducted)

[发放中] step2 (发放人接收) --confirm(actor=distributor)--> current_step=3

        step3 (发放人移交) --transfer(actor=distributor, recipients[])-->
              set those recipients 待接收 -> 已移交 (partial allowed, idempotent)
              when ALL recipients in {已移交, 已接收} -> step3 已完成, current_step=4

        step4 (接收人接收) --signoff(actor=recipient employee)-->
              recipient -> 已接收
              when ALL recipients 已接收 -> step4 已完成, distribution.status=已完成
```

Transition rules (enforced server-side, not in the UI):
- Only the step in `进行中` may complete; a `待执行` step cannot be actioned (matches current guard `step.status !== '进行中'`).
- step2 may only complete after step1 `已完成`; step3 after step2; step4 after step3.
- step3 accepts **partial** transfers (current `confirmTransfer` already supports this) and is idempotent — re-transferring an `已移交`/`已接收` recipient is a no-op.
- step4 sign-off is **only valid from the recipient's own authenticated session** (the recipient signs for themselves; a dispatcher cannot sign on their behalf) — this is the anti-fraud control the audit wants. Batch sign-off (`batchConfirmReceive`) is retained for a depot tablet where each recipient still authenticates.
- `已取消` allowed only from `待审批`/`已批准` (before any stock movement).

### 4.2 Requisition (领取) — 2-step chain

`审批中 → 已批准 → 发放中 → 已完成` (+ `已驳回`).
```
[审批中] --approve--> [已批准]; generate 2 steps; step1 -> 进行中
[已批准] --step1 仓库出库 (transactional stock deduct, closes G6)--> [发放中] current_step=2
[发放中] --step2 领取人签收 (actor=applicant)--> [已完成]
```

---

## 5. Concurrency, idempotency, offline replay

- **Idempotency keys:** every step-completion / sign-off request carries a client-generated `Idempotency-Key`. Replaying the same key returns the original result (no double stock deduction). This is what makes offline replay safe.
- **Optimistic locking:** step transitions require the expected `current_step`; a stale client gets `409 Conflict` and must refresh.
- **Offline queue (mobile):** sign-offs captured offline are stored with `Idempotency-Key` + `occurred_at` (client clock) + `actor_id`. On reconnect they replay in order. Server stamps its own `occurred_at` for the ledger but preserves client `occurred_at` in `payload.captured_at` for honesty about offline capture. Conflict rule: if the step was already completed server-side, the replay is a no-op success (never double-count).
- **Stock safety under concurrency:** the `qty <= stock` check + decrement + movement insert happen in **one serializable transaction**, so two concurrent step-1 completions cannot oversell stock.

---

## 6. API surface (v1)

REST, JSON, authenticated. Base `/api/v1`. All mutating endpoints write a `chain_event`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/inventory?low_stock_only=` | List items; `low_stock_only=1` → `stock < min_stock` |
| GET | `/inventory/{id}/movements` | Ledger for one item (audit view) |
| POST | `/inbound` | Create inbound (status 待质检) |
| POST | `/inbound/{id}/quality` | Record quality result; if 合格 → complete + stock_movement(+in) |
| GET | `/distributions` / `/distributions/{id}` | List/detail (includes recipients + steps) |
| POST | `/distributions` | Create 发放申请 (status 待审批); server computes `qty = per_person_qty * total_people` via `calcTotalFromUnits` |
| POST | `/distributions/{id}/approve` | 待审批→已批准; requires completed `approval_id` (G3) |
| POST | `/distributions/{id}/steps/{n}/complete` | Complete step n (n=1 triggers transactional stock deduct, G1/G2) |
| POST | `/distributions/{id}/transfer` | step3 partial transfer; body `{recipient_ids:[...]}` |
| POST | `/distributions/{id}/signoff` | step4; **principal must be the recipient** |
| GET | `/requisitions` / `/{id}` | List/detail |
| POST | `/requisitions` / `/{id}/approve` / `/{id}/steps/{n}/complete` | Requisition flow |
| GET | `/events?ref_type=&ref_id=` | Audit trail (chain_events) |
| GET | `/reports/stock-movement?from=&to=` | Movement report |
| GET | `/reports/low-stock` | Low-stock / safety-line report |

Error contract: `409` for stock-shortfall / stale-step conflicts (body names the offending item + available qty); `403` for sign-off by non-recipient; `422` for approval-missing (G3).

---

## 7. RBAC for Sub-system A (maps to L1–L5)

| Action | 一线/接收人 (L5) | 班组长 (L4) | 车队/发放人 (L3) | 仓库负责人 (L3) | 综合管理/审批 (L2) | 决策层 (L1) |
|---|---|---|---|---|---|---|
| Create 发放/领取申请 | – | ✓ (领取) | ✓ | – | ✓ | ✓ |
| Approve | – | – | – | – | ✓ | ✓ |
| 仓库出库 (step1) | – | – | – | ✓ | ✓ | – |
| 发放人接收/移交 (step2/3) | – | – | ✓ (own) | – | ✓ | – |
| 接收人签收 (step4) | ✓ (self only) | ✓ (self) | ✓ (self) | – | – | – |
| Adjust stock / inbound | – | – | – | ✓ | ✓ | – |
| View audit trail | – | – | own | own | ✓ | ✓ |

**Sign-off self-only rule** (§4.1) is the control that makes the chain defensible for 履约/审计 — a supervisor cannot sign on a worker's behalf.

---

## 8. Acceptance tests

Each is automatable against the API. The prototype's manual scenarios (T01–T15) map onto these; A's subset is the issuance/requisition/stock chain.

**A-T1 Stock deduction on distribution (closes G1).** Seed `INV-001` stock=500. Create 发放 covering 40 people × 2 双 = 80. Approve → complete step1. Assert: `stock=420`, one `stock_movement(delta=-80, reason=distribution_out, ref=MD-...)`, `qty_after=420`.

**A-T2 Stock-safety rejection (closes G2).** `INV-004` stock=15, min=20. 发放 for 10 people × 2 套 = 20. Approve → complete step1 → expect `409` naming `INV-004`, available=15, requested=20; stock unchanged; no movement written.

**A-T3 Approval precondition (closes G3).** Create 发放 with no completed approval → call approve with `approval_id=null` → expect `422`.

**A-T4 Partial transfer then sign-off.** 3 recipients. step3 transfer 2 of 3 → step3 still 进行中, note "已移交 2/3". Transfer 3rd → step3 已完成, current_step=4. Sign all 3 (as themselves) → distribution 已完成.

**A-T5 Sign-off self-only (anti-fraud).** Attempt step4 sign-off for recipient `employee_id=7` authenticated as `employee_id=13` → `403`.

**A-T6 Idempotent offline replay.** Complete step1 with `Idempotency-Key=K`. Replay same request with `K` (simulating reconnect) → `200`, stock deducted **once**, one movement row.

**A-T7 Concurrent step1 does not oversell.** Two distributions each for the last 60 units of an item with stock=100, both complete step1 concurrently → exactly one succeeds, other `409`; final stock consistent with movements.

**A-T8 Requisition 2-step (closes G6).** Create 领取 for 3 桶 机油, approve, step1 → stock decremented + movement; step2 applicant signs → 已完成.

**A-T9 Inbound quality gate.** Inbound status 待质检; quality=不合格 → stock **not** increased, status stays 未完成; quality=合格 → stock increased, movement(+in) written.

**A-T10 Audit trail integrity (closes G5).** Perform a full MD lifecycle; GET `/events?ref_id=MD-...` → ordered events (approval_granted, step_completed×4, stock_deducted, transfer, signoff×n); each `event_hash` chains to `prev_event_hash`; tampering with a middle row breaks the chain (verified by recompute).

**A-T11 Low-stock report.** After A-T2, `GET /reports/low-stock` includes `INV-004` (stock 15 < min 20).

**A-T12 Persistence across restart (closes G4).** Complete a step, restart the service, GET the distribution → state persisted (no loss on refresh — the doc's #1 business risk).

---

## 9. Out of scope for A v1 (explicitly deferred)

- **外租设备台账** (G7) — sibling register, Phase A3.
- **Real-time GPS / vehicle telemetry** — Sub-system C; the existing snow *simulator* stays as the demo centerpiece.
- **Automated payroll deduction from performance scores** — legal/HR sensitivity; Sub-system B reports only.
- **Live 城运平台 interface** — A v1 only *shapes* its data for later roll-up (§6 reports + `chain_events` give the raw material). Obtaining the actual interface spec is a separate workstream.

---

## 10. Open questions (assumptions to confirm)

1. **Approval policy:** is a completed approval **always** required before the execution chain (default in §4.1), or are there low-value issuances that skip approval? The seed data has one approval-less MD, so confirm intended policy. *(Assumption 3 in the audit — flagged.)*
2. **Sign-off identity:** does every 班组长/车队长 have a phone and an account to sign for themselves (A-T5 assumes yes)? If not, a depot-tablet PIN-per-worker flow is needed.
3. **Stock ownership:** is inventory per-depot (single location) or multi-depot? Model above is single-location; multi-depot adds a `location_id` dimension.
4. **Cost roll-up:** is `total_cost` informational, or must it reconcile to a budget/预算 (affects whether we add budget checks)?
5. **PII handling:** issuance records tie names/IDs to items — confirm 个人信息保护法 handling (retention, access scope) before production.

---

## Appendix — Mapping to prototype functions

| Prototype function | Spec target |
|---|---|
| `autoMatchRecipients()` | `POST /distributions` recipient derivation (unit-leader dedup) |
| `calcTotalFromUnits()` | server-side `qty = per_person_qty * total_people` |
| `generateDistributionWorkflow()` | `approve` → insert 4 `workflow_step` rows |
| `approveDistribution()` | `POST /distributions/{id}/approve` (+ G3 gate) |
| `executeMatDistStep()` step1 | `/steps/1/complete` + **transactional stock deduct (G1/G2)** |
| `showTransferModal`/`confirmTransfer()` | `POST /distributions/{id}/transfer` (partial, idempotent) |
| `confirmReceive`/`batchConfirmReceive()` | `POST /distributions/{id}/signoff` (self-only, A-T5) |
| `executeReqStep()` | `/requisitions/{id}/steps/{n}/complete` (+ G6 stock deduct) |
| inbound `stock += qty` (render) | `/inbound/{id}/quality` on 合格 |
| outbound `stock -= qty` (seed only) | `stock_movement` ledger (replaces hand-authored rows) |
