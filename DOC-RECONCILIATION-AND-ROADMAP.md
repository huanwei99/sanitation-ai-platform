# Doc Reconciliation & Roadmap Unification

Resolves the contradictions across the three planning docs and unifies the roadmaps · Draft v0.1

This closes the open grounding item from the audit: PROJECT-SOLUTION-DOC.md is now read in full and reconciled against 项目正式文档.md, platform-upgrade-plan.md, and the **actual code**. Two material contradictions were confirmed, plus roadmap triplication.

---

## 1. Contradiction #1 — Persistence baseline (CONFIRMED, sharper than reported)

| Source | Claim |
|---|---|
| **PROJECT-SOLUTION-DOC** §二.1, §3.1, §四 | "渐进增强架构 **localStorage → IndexedDB**"; "**IndexedDB 主存储** + JSON 导出/导入"; migration "启动时检测 localStorage 旧键…一次性迁移至 IndexedDB" |
| **PROJECT-SOLUTION-DOC** §风险 R1 | Treats "IndexedDB 数据丢失" as a live risk — i.e., assumes IndexedDB is the operating store |
| **项目正式文档** §4.1 | Lists "数据不持久 / 刷新页面数据丢失" as a **current high business risk** |
| **Code (verified)** | **Neither.** Exactly **1 vestigial `localStorage` call per HTML file**; **0 `IndexedDB`**. All business data is in-memory JS arrays, lost on refresh. |

**Resolution (authoritative):** The code is the truth. Persistence is **not implemented in any form** — not localStorage, not IndexedDB. Both docs describe a *planned* state (PROJECT-SOLUTION-DOC) and a *feared* state (项目正式文档), but neither describes the *actual* state.

**Impact on Sub-system A spec:** None — the spec already assumes no persistence and routes all state through the **Phase-0 server DB**. In fact this strengthens the case: the docs' own P0 "数据层 (IndexedDB)" is now **superseded** by Phase-0's server-backed store, because IndexedDB-per-browser still cannot sync a field phone to the office PC (the BroadcastChannel limitation, which PROJECT-SOLUTION-DOC §R4 explicitly concedes: "BroadcastChannel 不跨设备"). **Do not build the IndexedDB-first P0 from PROJECT-SOLUTION-DOC; build Phase 0 instead.**

---

## 2. Contradiction #2 — Backend: "avoid it" vs. "it's mandatory"

| Source | Claim |
|---|---|
| **PROJECT-SOLUTION-DOC** §二.1 设计原则 | "能纯前端解决的不引入后端；引入后端时只做最小化代理层" (avoid backend; if forced, minimal proxy only). Backend framed as a **mid-term/optional** item (§六 云端部署 中期) |
| **Audit + Sub-system A spec** | A server is **mandatory now** — cross-device field sign-off is architecturally impossible without it |

**Resolution:** These are reconcilable only by rejecting the doc's "avoid backend" principle **for the sign-off/chain use case**. The doc's principle is sound for *static content* but wrong for *multi-user transactional state*. PROJECT-SOLUTION-DOC itself hints at this in §AI ("纯前端直连有 CORS 限制，需要最小的服务器代理"), and R2 concedes concurrency needs a backend eventually ("中期上后端做乐观锁").

**Decision:** Promote the backend from "mid-term optional" to **Phase-0 now**, scoped narrowly (auth + persistence + RBAC + offline-replay). This directly contradicts PROJECT-SOLUTION-DOC's §六 sequencing, which is why the roadmaps must be unified (below).

---

## 3. Roadmap triplication — three incompatible plans

| Source | Roadmap |
|---|---|
| **项目正式文档** §9.2 | 4-phase: mock → **backend API** → Docker → mobile |
| **PROJECT-SOLUTION-DOC** §六 | P0–P5, **IndexedDB-first**, backend deferred to "中期" (第 1–2 周 P0 数据层 = IndexedDB) |
| **platform-upgrade-plan.md** | 10 modules, priority order 权限→数据层→报表→…, **no sequencing/dates** |

**The core conflict:** 项目正式文档 puts **backend API in phase 2**; PROJECT-SOLUTION-DOC defers it to **mid-term** and does IndexedDB first. These are mutually exclusive. platform-upgrade-plan is a backlog, not a schedule.

---

## 4. Unified roadmap (single source of truth — supersedes all three)

Anchored to **dependencies, not calendar weeks** (no owners/dates yet — that's a project-plan workstream). Calendar dates are deliberately omitted until an owner is assigned.

| Phase | Content | Replaces | Exit criteria (verifiable) |
|---|---|---|---|
| **P0 Foundation** | Server (Node/Fastify + SQLite) + Caddy same-origin + AuthN (bcrypt/session) + **three-factor RBAC middleware** + **offline-replay idempotency** + seed-from-prototype migration | PROJECT-SOLUTION-DOC's IndexedDB-first "P0 数据层" + 项目正式文档's "backend API" phase (merged) | Refresh/restart loses no data (A-T12); login is real; `hasPermission` enforced server-side; a sign-off replays idempotently offline→online (A-T6) |
| **P1 Sub-system A** | Materials/warehouse/distribution chain per spec (transactional stock deduct, self-only sign-off, audit `chain_event`, mobile sign-off, reports) | platform-upgrade-plan's scattered 库管 items | A-T1…A-T12 pass |
| **P2 Sub-system B** | Performance/履约 scorecard on the 4 hard dimensions (defer 协作) | platform-upgrade-plan §十 | Score recomputes deterministically from seed rows; role weight-profiles correct |
| **P3 Demo centerpiece** | Snow/emergency **simulator** kept polished as the demo (NOT live GPS) | platform-upgrade-plan's 地图 P3 (deferred) | Simulator replays 12/3 scenario end-to-end |
| **P4 Compliance-shaped export** | 城运平台/履约 roll-up report format from `chain_events` + scores | new (from audit strategic finding) | A project-level 履约 report renders from real event data |
| **Defer** | Live GPS/video (C), Docker/multi-tenant/cloud, live 城运 interface, AI/`callLLM()` | — | Revisit only after P1–P2 are production-grade |

**Key sequencing rule:** the plan's own "权限体系是所有模块基础 (P0)" is honored — RBAC is inside P0 Foundation. But **数据层 is re-scoped from IndexedDB to server-DB**, which is the one deliberate divergence from PROJECT-SOLUTION-DOC and the reason this unification exists.

---

## 5. Repo hygiene items surfaced (from PROJECT-SOLUTION-DOC §交付物)

PROJECT-SOLUTION-DOC's deliverable table cites **"index.html… 10 807 行"** and **"mobile.html… 2 496 行"** — but the actual files are **10,003** and **2,397** lines (verified). The doc's numbers are stale/estimated. Minor, but it confirms the docs and code have drifted and the **code is authoritative**. Also reconfirms: delete the orphaned `js/app.js` + `js/data.js` (superseded second implementation) so the deliverable list matches reality.

---

## 6. What this reconciliation changes in the prior artifacts

- **Sub-system A spec:** no change to content; §2 Phase-0 reference is now the **mandatory** path (not the IndexedDB option). Contradiction #1 confirms the spec's "code wins over docs" stance.
- **Phase-0 architecture:** confirmed correct; its §1 rationale (BroadcastChannel can't cross devices) is now backed by PROJECT-SOLUTION-DOC's **own R4 admission**, so it's not just the auditor's opinion — the project's own risk register agrees.
- **Assumptions:** Assumption 4 ("server-backed foundation is required") is now corroborated by the project's own docs, upgrading it from auditor recommendation to an internally-consistent requirement.

---

## 7. Remaining open items (not resolvable from the docs)

1. **Owners & dates** for the unified roadmap — needs a named team/capacity (the docs name roles but no people).
2. **Approval policy** (Sub-system A spec §10 Q1) — PROJECT-SOLUTION-DOC SOP-05 confirms current approvals are "简单状态切换" and a configurator is planned, but doesn't say whether approval is mandatory before issuance. Still open.
3. **Sign-off identity on field devices** (spec §10 Q2) — SOP-Org-03 defines account issuance (default password `Aa@123456`, forced change, 5-strike lockout) which is a **good baseline** the spec can lean on; but whether every 班组长 has a device is still unconfirmed.
4. **城运平台 interface spec** — needs direct engagement with the local 城管局; not in any doc.

---

**Bottom line:** The three docs disagree on persistence and backend sequencing, and the code disagrees with all of them. The unified roadmap above resolves it in one direction: **server-backed foundation first (P0), then Sub-system A, then B** — deliberately overriding PROJECT-SOLUTION-DOC's IndexedDB-first/backend-deferred plan because the project's own R4 risk admission ("BroadcastChannel 不跨设备") proves that plan cannot serve the field sign-off scenario that justifies the product.
