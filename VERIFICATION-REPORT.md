# Project Verification Report

**Project:** 环卫·清雪智慧运营管理平台 (Sanitation & Snow-Clearing Smart Operations Management Platform)
**Verification scope:** Technical architecture, overall design, lifecycle/maintainability sustainability, development plan, implementation plan
**Verification date:** 2026-11-16
**Method:** Read every core document in full, inspected SQL migrations + Node test harness, ran the test suite, and cross-checked documented claims against actual code (grep/read of `index.html`, `mobile.html`, `foundation/*`).
**Authoritative copy:** `D:\proj\cd\work\` (the only git-tracked tree; root-level and `san/` copies are stale duplicates — see F1).
**⚠ Read §10 Addendum:** the Dry-Run sprint landed on `origin/main` during verification (HEAD `a85565d`, 2026-11-16); findings A1/M3/I2 and recommendation #2 are superseded by events.

---

## 0. Executive summary

| Dimension | Verdict | Headline |
|---|---|---|
| Technical architecture | **Strong (design) / Unbuilt (code)** | Phase-0 server + SQLite + RBAC + offline-replay design is coherent, dependency-driven, and grounded in the project's own risk register. But **no server, `package.json`, or CI exists yet** — only the schema and a 22-test harness. |
| Overall design | **Good, with drift** | Sub-system A spec is audit-grade and code-grounded. Two internal contradictions (IndexedDB-first vs server-first; backend-avoid vs backend-mandatory) were correctly resolved toward server-first, but `PROJECT-SOLUTION-DOC.md` was **not rewritten** to match, so it still misleads. |
| Maintainability / lifecycle | **Mixed** | Append-only `chain_event` ledger, retention table, and nightly-backup intent are sound. But retention/archival is **policy-on-paper only**, the 10,807-line `index.html` is a structural liability, and no backup/CI automation exists. |
| Development plan | **Well-structured, resourcing gap** | DEMAND-POOL (29 tasks) + Gated roadmap (Gate-DR→0→1→2→4→Go/No-Go) is one of the stronger planning artifacts. Risk: **all 29 tasks are 待认领 (unclaimed)** and only one named person (Daniel) exists — a decision-maker, not implementers. |
| Implementation plan | **Credible but aggressive** | A real 22-test harness proves the hard invariants (stock, self-only, idempotency, hash chain). But the Dry-Run sprint is dated to start **2026-11-16 — the same day as this verification** — with zero tasks claimed and no server scaffolding in repo, so the window to staff it has effectively closed. |

**Bottom line:** This is a **well-audited, well-specified project whose planning/documentation quality is unusually high**, grounded in a genuine audit that found real code defects (verified below). The single largest risk is **execution capacity, not design**: the documents and tests are ahead of the implementation, the implementers are unnamed, and the sprint clock has effectively started. Several doc claims are themselves stale and should be corrected so the docs stop drifting (the project's own stated principle is "code wins over docs").

---

## 1. Workspace & provenance findings

- **F1 — Triplicated tree with divergence (Medium, but lower-risk than it first appears).** The same project exists at repo root, in `work/`, and in `san/`. Only `work/` is a git repo (remote `github.com/huanwei99/sanitation-ai-platform`), making it authoritative. Verified divergence:
  - `ROADMAP-EXECUTION-PLAN.md` **genuinely differs** between root and `work/`: root is v1.0 (90 lines), `work/` is v1.1 with the Dry-Run sprint (102 lines).
  - **File presence/absence differs:** `san/` lacks `DEMAND-POOL.md`, `DR-SPRINT-TRACKING.md`, `PHASE0-…`, `ROADMAP-…`, `SUBSYSTEM-A-…`, `foundation/`; it has `zhengshi.md`/`style.css` that map to `work/项目正式文档.md`/`css/`.
  - **The four "differing" content files are line-endings-only:** `index.html`, `mobile.html`, `PROJECT-SOLUTION-DOC.md`, `platform-upgrade-plan.md` are **identical between `san/` and `work/` once CRLF/LF is normalized** (`diff --strip-trailing-cr` = 0 changed lines for all four). The only substantive content divergence in code is the orphan `js/app.js` (82,192 B in `san/` vs 84,212 B in `work/`) and `js/data.js` (22,553 vs 22,767 B) — which are the superseded second implementation slated for deletion anyway.
  - **Action:** declare `work/` canonical and collapse to a single source of truth. Because the HTML/doc duplicates are content-identical, this is lower-risk than a byte-level diff suggests — mainly a line-endings normalization plus removing stale copies.
- **F2 — Orphan second implementation still present (Low, already tracked).** `js/app.js` (84 KB) + `js/data.js` (22 KB) exist and are documented as the superseded implementation to delete (`DEMAND-POOL` QW-T01, Phase-0 §6). Confirmed still on disk.

---

## 2. Technical architecture — assessment

### What is sound
- **Phase-0 reference architecture (`PHASE0-BACKEND-RBAC-ARCHITECTURE.md`) is the strongest artifact.** It correctly identifies the architectural blocker: the plan's own `BroadcastChannel` strategy is **same-browser-tabs only**, so cross-device field sign-off (a field worker signing on a phone → office PC) is *impossible* without a server. This is corroborated by the project's own risk R4. The conclusion "server is mandatory, not optional" is correct and well-argued.
- **Tech stack is pragmatic and low-risk:** Node 20 + Fastify, SQLite (WAL) via `better-sqlite3`, session cookies (HttpOnly), bcrypt/argon2, Caddy same-origin reverse proxy. Single-process / single-file / zero-ops fits the locked-down LAN constraint. Postgres named as the portability upgrade path.
- **Schema (`001_init.sql`, `002_multi_depot.sql`) is genuinely well designed:** normalized, `employee_id` FK spine preserved (keeps cross-module drill-down working), money in integer minor units (分) to avoid float error, CHECK constraints on every enum, `stock >= 0` invariant, append-only `stock_movement` single-ledger (audit backbone), hash-chained `chain_event`, `idempotency_keys` table, `org_policy` toggles (no hardcoded policy), and a clean multi-depot extension (depot-scoped inventory/movement/documents). Comments are in-language and explain *why*.
- **Three-factor RBAC ported server-side** (menu × action × data-scope, L1–L5 ladder, hierarchical "only downward" authorization) — moving enforcement from bypassable client `hasPermission()` to API middleware is the single most important security change, and it is correctly prioritized.

### Gaps / risks
- **A1 — Architecture exists only on paper (High).** No `package.json`, no server entry, no `Caddyfile`, no `src/`. The entire Node/Fastify/SQLite/auth/RBAC stack is undesigned-in-code. The only working artifacts are `foundation/` (SQL + tests). This is expected pre-sprint but must be stated plainly: **the architecture is verified as a design, not as a running system.**
- **A2 — Append-only is not DB-enforced (Medium).** `chain_event` and `stock_movement` are "append-only" by convention and by the app layer. Nothing at the DB level prevents `UPDATE`/`DELETE` on these tables (no triggers/permissions). A compromised or buggy server process can rewrite the tamper-evident trail. For a product whose selling point is audit-grade 履约 evidence, consider SQLite triggers or a separate append-only store / external hash anchoring.
- **A3 — Multi-tenant readiness is overstated (Low-Medium).** Phase-0 §10.1 says the model "carries an implicit `project_id`." In the actual schema, `permissions` has **no** `project_id`; tenant scoping lives only on `employees`. Multi-tenant would require touching the permission model, not just data rows.
- **A4 — Concurrency control is spec'd, not yet proven at SQL layer (Medium).** A-T7 (two concurrent step-1 completions must not oversell) passes in the **in-memory** engine but has **no SQL-layer test** (the SQL suite covers A-T1/2/3/5/6/9/10/11/13 only). The spec relies on a "single serializable transaction," but `better-sqlite3` serialization semantics under WAL for this exact path are unverified. Add a SQL A-T7.

---

## 3. Overall design — assessment

### What is sound
- **`SUBSYSTEM-A-MATERIALS-SPEC.md` is audit-grade.** It grounds every requirement in actual code (named functions/constants), enumerates real defects G1–G7, then specifies the fix with state machines, idempotency/conflict rules, an API surface, an RBAC matrix, and 12 acceptance tests. The "code wins over docs" stance is the right discipline.
- **The five locked decisions (2026-11-13) are all sensible and now encoded in schema + tests:** approval forced as precondition (A-T3), self-only sign-off with no PIN fallback (A-T5), multi-depot (A-T13), paid-buyer/free-trial GTM, Daniel as roadmap owner.
- **Contradiction resolution (`DOC-RECONCILIATION-AND-ROADMAP.md`) is correct in direction:** it overrides the IndexedDB-first / backend-deferred plan because the project's own R4 proves that plan cannot serve the field sign-off scenario that justifies the product.

### Gaps / risks (verified against code)
- **D1 — `PROJECT-SOLUTION-DOC.md` was never reconciled (High, doc-hygiene).** The reconciliation doc decides persistence = **server DB** and backend = **Phase-0 now**, explicitly superseding `PROJECT-SOLUTION-DOC`'s IndexedDB-first P0. But `PROJECT-SOLUTION-DOC.md` §3.1 still reads "IndexedDB 主存储," §设计原则 still says "能纯前端解决的不引入后端," and §六 P0 week 1–2 is still "数据层 (IndexedDB)." A reader of the formal doc alone would build the wrong thing. The reconciliation doc *says* it supersedes, but the superseded doc carries no deprecation banner. **Action:** add a prominent header to `PROJECT-SOLUTION-DOC.md`: superseded on persistence/backend sequencing by Phase-0 + reconciliation; or edit those sections.
- **D2 — Verified code defects (confirm the audit was real).** I confirmed by reading `index.html`:
  - **G1 (stock not decremented on distribution):** `executeMatDistStep()` step 1 (lines 7952–7967) advances the workflow and flips status to 发放中 but **never touches `inventoryItems[].stock`** and never writes an outbound record. Confirmed.
  - **G4 (no persistence, mock auth):** `handleLogin()` (lines 2314–2322) hard-codes `currentUser = { name:'李明', permissions:['all'] }` regardless of input. Confirmed.
  - **G2/G3/G5/G6** are consistent with the surrounding code (no `qty<=stock` gate at issue; `approveDistribution` (`index.html:8178`) runs on a nullable prototype field `d.approvalId` — camelCase in the prototype, mapping to the SQL `approval_id` — and skips approval sync when it's falsy; no event log; requisition path likewise unwired). The audit is credible.
- **D3 — The reconciliation doc's own claims are now stale (Medium, irony).** It asserts "exactly **1 vestigial `localStorage` call per HTML file**; **0 IndexedDB**" and "actual files are **10,003 / 2,397** lines." Re-verified today:
  - `localStorage` appears **20×** in `index.html` (a real mobile-sync + chat persistence path: `MOBILE_SYNC_KEY`, `CHAT_STORE_KEY`), not 1×; `IndexedDB` = 0 (this part holds).
  - Actual line counts are **10,807 (`index.html`) / 2,496 (`mobile.html`)** — which now matches `PROJECT-SOLUTION-DOC`'s "10 807 / 2 496," meaning the *reconciliation* doc's "stale numbers" callout is itself outdated.
  - Net: the design principle "code wins" is right, but the meta-docs keep drifting. **Action:** re-verify these specific claims and add a "verified as of <date>" stamp, or stop citing exact counts.

---

## 4. Maintainability & lifecycle sustainability — assessment

### What is sound
- **Data lifecycle is thought through on paper:** master vs transaction data split, per-entity retention/archival table (2y attendance, 5y warehouse/issuance for finance, permanent emergency/performance), and a create→use→revise→archive→clean chain with daily snapshots + manual export. `chain_event` doubles as the security audit trail.
- **Backup intent is right:** nightly `sqlite3 .backup` to dated file, 7–30 day retention, quarterly restore verification (Phase-0 §9). Moving the plan's backup instinct server-side is correct.
- **Test harness as a maintainability asset:** `foundation/tests` (13 in-memory + 9 SQL, **all 22 pass** — re-run and confirmed) encode the hard invariants as regressions. `engine.js` replicates SQL invariants in pure JS so logic is proven before SQL landing. This is a genuinely good "prove-then-land" pattern and a durable guardrail.

### Gaps / risks
- **M1 — Retention/archival/backup are policy-only (High for lifecycle).** No archival job, no backup script, no restore-verification procedure exists. The 5-year finance retention and "nightly backup" are aspirations. Until P0-T05 (deploy/runbook + backup script) lands, the #1 business risk (data loss, R1) is **unmitigated in code**. Given IndexedDB/localStorage is not the store and there is no server yet, the *current* prototype still loses everything on refresh.
- **M2 — `index.html` at 10,807 lines is a structural liability (Medium).** The docs acknowledge this (R7) and queue QW-T03 (split assessment, evaluate-only). With 19+ modules, single-file inline JS/CSS will increasingly resist safe change, onboarding, and review. The plan to split into `<script src>` files while staying zero-build is reasonable — but it is deferred, and every week of feature work on the monolith raises the cost of the eventual split.
- **M3 — No CI yet (Medium).** No `.github/`. The 22-test guardrail is only run manually. P0-T06 (GitHub Actions `node --test`) is the cheapest possible protection for the project's best asset and should be done **immediately**, not after the sprint — it is independent of the server build and would catch regressions in the harness itself during the sprint.
- **M4 — Postgres portability untested (Low).** Claimed portable "unchanged" but no Postgres migration or dialect test exists. Acceptable to defer; just don't treat it as a proven property.
- **M5 — Compliance/PII is explicitly open (acknowledged).** Phase-0 §10.8 and spec §10 Q5 flag 个人信息保护法 handling as designed-for but not fully mapped. Honest, but it is a real pre-production workstream (retention, access scope, encryption-at-rest).

---

## 5. Development plan — assessment

### What is sound
- **`DEMAND-POOL.md` is a strong execution instrument:** 29 tasks across Dry-Run (8), P0 (7), P1 (7), quick-wins (3), GTM (3), P2-prep (1); each with acceptance criteria, dependencies, effort (S/M/L with person-day definitions), skills, claimant, status. Claim-to-accept workflow + "definition of done = acceptance criteria pass + tests green" is disciplined.
- **`ROADMAP-EXECUTION-PLAN.md` v1.1 is dependency-aware and gated:** Dry-Run (11-16→11-27) → Gate-DR → P0 (→12-19) → Gate-0 → P1 (→01-22) → Gate-1 → P2 (→02-19, Spring-Festival buffered) → Gate-2 → P4 (→03-12) → Gate-4 → Go/No-Go 03-26. A calendar was added on top of the dependency-anchored unified roadmap once Daniel owned it — exactly the right evolution.
- **Sequencing guardrails are correct:** Phase-0 §11 correctly forbids building Sub-system A endpoints (0.6) before RBAC (0.4) + idempotency (0.5) exist, because the audit controls (A-T2/T5/T6) have nothing to stand on otherwise.
- **"No-GO isn't wasted" is good risk framing:** Dry-Run outputs (skeleton/migrations/auth/audit chain) are P0 components regardless of outcome.

### Gaps / risks
- **P1 — Resourcing is the critical-path risk (High).** All 29 tasks are **待认领**. Only **Daniel** is named, and he is explicitly the *decision-maker* (拍板人), not an implementer. The plan's own top risk ("冲刺期实施人未认领") is **live**: the mitigation is "Daniel 点名指派 T01/T02/T04/T06," but there is no evidence a bench of implementers exists. **No plan survives this gap if nobody builds.** This is the #1 thing to resolve before 11-16.
- **P2 — Sprint timeline is aggressive (Medium).** 10 working days to deliver server skeleton + SQLite + auth + distribution chain + audit chain + mobile sign-off + SQL tests + rehearsal script, with the critical path T01→T02→T04→T06→T07. The effort sizes (T02=M=3–5 person-days, T04=M critical, T07=M) roughly fit *if* 2–3 implementers are on it full-time — reinforcing P1. The scope-lock discipline (§D alternative pool, "risk exposed not carried overnight") is the right defense.
- **P3 — DR-SPRINT-TRACKING "auto-sync" is not implemented (Low).** The tracking board says "每周五 18:00 自动同步 (拉取 commit → 更新状态)." There is no automation in the repo — it is a manual process described as automatic, with only a base-line entry and an HTML comment template. Harmless, but it over-promises; label it manual or actually wire it.
- **P4 — No named implementers / no onboarding path (Medium).** QW-T02 (root README + LICENSE, "new person running in 10 minutes") is still open, and there is no root README/LICENSE. For a claim-based, contract-worker-friendly model, onboarding material matters.

---

## 6. Implementation plan — assessment

### What is sound
- **A real, runnable acceptance harness exists and passes (verified today):**
  - `node --test tests/engine.test.js` → **13 pass / 0 fail** (in-memory, zero-dependency).
  - `node --test tests/sql.test.js` → **9 pass / 0 fail** (real SQLite, runs migrations + transactions).
  - Runs on Node v24.15.0 with `node:test`/`node:crypto`/`node:sqlite`, **no `npm install`**. This is a legitimately strong verification asset — the hardest controls (transactional stock deduct, `qty<=stock` reject, approval precondition, self-only sign-off, idempotent replay, hash-chain tamper detection, low-stock, multi-depot isolation) are proven, not just specified.
- **Acceptance tests map 1:1 to the defects they close** (A-T1↔G1 … A-T12↔G4), so "done" is objectively checkable. The Gate definitions (Gate-DR/0/1) are phrased as test outcomes, not vague milestones.
- **sql.test.js is positioned as the reference implementation** (`withTx`/`deductOnce`/`recordEvent`+`verifyChain`/`withIdem`) to be ported into the server rather than reinvented — reduces sprint risk.

### Gaps / risks
- **I1 — SQL test coverage is incomplete vs its own baseline (Medium).** README says SQL suite = "9 pass"; but the spec's control set implies SQL should also cover **A-T7 (concurrency/oversell)** and **A-T12 (persistence-across-restart)**. A-T12 "SQL 版" is cited as a P0-T02/DR-T02 acceptance criterion, yet the SQL suite today does not include it as a true restart test (it is simulated in-memory). Add SQL A-T7 and a real restart A-T12.
- **I2 — Nothing is wired end-to-end yet (expected, but real).** No server consumes the migrations; no mobile page calls the sign-off API; Caddy is absent. The Dry-Run's stated goal ("真登录 → 真扣库存 → 真签收 → 审计链可验证") requires DR-T01–T08 to all land. The harness proves the *logic*; the sprint must prove the *integration*. This is precisely what a dry-run is for, so it is appropriate — provided P1 resourcing is solved.
- **I3 — Default credentials pattern (Low).** `PROJECT-SOLUTION-DOC` SOP-Org-03 ships default password `Aa@123456` (admin `admin123`) with forced-change-on-first-login. Acceptable as a bootstrap, but ensure the server never stores plaintext and the forced-change is enforced server-side (schema has `password_hash`, good). Flag for the security review.
- **I4 — Assumptions still unconfirmed (Medium).** Several Go/No-Go-relevant assumptions remain open and are honestly listed (spec §10, reconciliation §7): approval-policy nuance, every 班组长 has a phone+account (Decision #2 asserts yes, but field reality unverified), 城运平台 interface spec, PII. Decision #2 being asserted rather than verified is the one most likely to invalidate the self-only control in the field.

---

## 7. Cross-cutting consistency check

| Item | Docs say | Code/repo says | Status |
|---|---|---|---|
| Persistence | `PROJECT-SOLUTION-DOC`: IndexedDB main store | 0 IndexedDB; 20 localStorage (mobile-sync/chat); business data in-memory | **Resolved toward server-DB** (reconciliation), but formal doc not updated (D1) |
| Backend | `PROJECT-SOLUTION-DOC`: avoid / mid-term optional | None built; Phase-0 says mandatory now | **Resolved toward Phase-0 now**; formal doc not updated (D1) |
| Line counts | Solution doc: 10,807 / 2,496; Reconciliation: 10,003 / 2,397 | 10,807 / 2,496 | Reconciliation's callout now stale (D3) |
| localStorage count | Reconciliation: 1 vestigial/file | 20 in index.html | Reconciliation claim wrong (D3) |
| Code defects G1–G6 | Audit says real | G1, G4 re-confirmed by reading functions | **Confirmed** (D2) |
| Orphan js/ | Should be deleted | Still present | Open (F2/QW-T01) |
| Engine tests 13 | README | 13 pass (re-run) | **Confirmed** |
| SQL tests 9 | README | 9 pass (re-run) | **Confirmed**; missing A-T7/A-T12-SQL (I1) |
| CI (P0-T06) | Planned | No `.github/` | Not started (M3) |
| Backup (P0-T05) | Planned nightly | No script | Not started (M1) |
| Auto-sync (tracking) | "自动同步" | No automation | Over-stated (P3) |

---

## 8. Prioritized recommendations

**P0 — do before/with the sprint start (blocks credible execution):**
1. **Resolve implementer resourcing (P1).** Daniel must name the 2–3 implementers for the DR critical path (T01/T02/T04/T06) — or the sprint will not start. This is the single highest-leverage action.
2. **Add CI now (M3/P0-T06).** A 5-line GitHub Actions running `node --test foundation/tests/*.test.js` protects the project's best asset immediately and is independent of the server. Do not defer to post-sprint.
3. **Deprecation-banner `PROJECT-SOLUTION-DOC.md` (D1).** Add a header pointing to Phase-0 + reconciliation for persistence/backend sequencing so nobody builds the superseded IndexedDB-first P0.

**P1 — during the sprint:**
4. **Add SQL A-T7 (concurrency/oversell) and a real restart A-T12 (I1).** These are named acceptance criteria for DR-T02/T04 and are currently unproven at the SQL layer.
5. **DB-enforce append-only (A2).** Add SQLite triggers (or equivalent) blocking `UPDATE`/`DELETE` on `chain_event`/`stock_movement`, since tamper-evidence is the product's audit selling point.

**P2 — before Go/No-Go:**
6. **Land backup + restore-verification (M1/P0-T05)** so R1 (data loss) is actually mitigated, not just documented.
7. **Start the `index.html` split assessment (M2/QW-T03)** and execute the split before piling on P1/P2 features, while the risk is still bounded.
8. **Confirm the field-device/account assumption (I4/Decision #2)** with real depot reality before trusting self-only sign-off in the pilot.

**P3 — hygiene:**
9. **Collapse the triplicated tree (F1)** to `work/` as canonical; archive/remove root and `san/` duplicates.
10. **Delete orphan `js/app.js` + `js/data.js` (F2/QW-T01)** and add root README/LICENSE (QW-T02).
11. **Re-stamp the drifting meta-doc claims (D3)** — the localStorage-count and line-count callouts — or replace exact counts with "verified as of <date>."

---

## 9. Verification method & evidence trail

- Documents read in full: `PROJECT-SOLUTION-DOC.md`, `PHASE0-BACKEND-RBAC-ARCHITECTURE.md`, `SUBSYSTEM-A-MATERIALS-SPEC.md`, `ROADMAP-EXECUTION-PLAN.md`, `DOC-RECONCILIATION-AND-ROADMAP.md`, `DEMAND-POOL.md`, `DR-SPRINT-TRACKING.md`, `foundation/README.md`.
- Code/config inspected: `foundation/migrations/001_init.sql`, `002_multi_depot.sql`; `index.html` (`handleLogin` 2304–2339, `executeMatDistStep` 7942–7987, transfer modal, stock references); `mobile.html` (login path); directory checks for `package.json`/`.github`/`server`/`Caddyfile`/`js/`.
- Tests executed (Node v24.15.0): engine 13/13 pass; SQL 9/9 pass.
- Claim checks via grep: `localStorage` count (20), `IndexedDB` count (0), line counts (`wc -l`), `permissions:['all']` mock login, stock-deduction absence in `executeMatDistStep`.
- Limitation: verification is **static + test-harness only**. No live server, no device, no real deployment was available, so integration, concurrency-at-SQL, backup/restore, and field-device behavior are assessed from design + tests, not from a running system.

---

## 10. Addendum — the Dry-Run sprint landed on origin/main during verification (2026-11-16)

**Scope note:** This report verified the local tree at `5f6d850` (2026-11-13 state). While verification was underway, the team pushed 8 commits (`e6094b5` 11-14 15:45 → `a85565d` 11-16 07:42) implementing the Dry-Run sprint. This addendum records the delta at new HEAD `a85565d`; the body above is preserved unmodified as the point-in-time snapshot it was.

**What landed (verified by inspection of the diff; server suite not executed):**
- **Server now exists (supersedes A1):** `server/` — Fastify app (`server.js`/`app.js`), `auth.js` (331 L), `distribution.js` (493 L), `audit.js`/`chain.js`/`db.js`, `package.json` + lockfile, `verify.ps1`, `seed-drill.js` (~5,000 lines added).
- **CI now exists (supersedes M3; recommendation #2 is done):** `.github/workflows/ci.yml` — Node 22/24 matrix, `npm install` + `npm test`, plus `node --test engine.test.js`.
- **Also added:** `Caddyfile`, `mobile-sign.html` (the mobile sign-off page), migrations `003_auth_lockout.sql` / `004_distribution_seed.sql`, `DRILL-SCRIPT.md`, `DR-OPTIMIZATION-LIST.md`, `C-2-UNLOCK-PROPOSAL.md`, and `COMPREHENSIVE-AUDIT-AND-EVOLUTION-PLAN.md` (a separate assessment whose scope overlaps this report).
- **Defect fixes pushed:** "A/B 级" fixes (审批鉴权、签收假成功、库存预检入事务、审计限权) plus C-1 / C-2① / C-2② / C-3. The latest commit claims **35 pass**; the server test files declare exactly 35 `test()` cases (claim consistent, but **not executed by this report** — the server suite requires `npm install`).
- **Timing:** the sprint package was delivered 11-14/11-15 — two days *ahead* of its 11-16 start. The "window to staff it has effectively closed" framing is overtaken by events.

**Still open at `a85565d` (spot-checked today):**
- **D1:** `PROJECT-SOLUTION-DOC.md` still carries **no deprecation banner** (header unchanged) → recommendation #3 stands.
- **Prototype defects G1/G4 are unchanged in `index.html`:** `executeMatDistStep` step 1 still touches no stock; `handleLogin` still mocks `permissions:['all']`. The fixes are server-side; the prototype remains a UI mock — confirm whether QW-T01's delete-and-seed plan is now the intended path for it.
- **DEMAND-POOL bookkeeping:** all 29 tasks remain 待认领 even though the work landed — the claim workflow was bypassed by direct implementation. Update statuses per the project's own evidence rule ("只有 commit/测试输出能改变状态").
- **A2 and I1 remain open:** migrations 003/004 add no triggers (append-only still not DB-enforced), and the concurrency/oversell path (A-T7) is **still untested at the SQL/server layer** — the server suite covers self-only, idempotency, approval gating, and the hash chain, but no concurrent step-1 oversell case.

---

## 11. Addendum update — re-verification executed against `a85565d` (2026-11-16)

The re-run recommended at the close of §10 has now been **executed**, not just proposed. Evidence below is from real runs on the current `main` tree.

**Server test suite — actually executed (confirms the commit's claim):**
- `cd server && npm install` → 52 packages, **0 vulnerabilities** (fastify ^5, `@fastify/cookie`, bcryptjs; `better-sqlite3` is an *optional* dep — the code prefers Node's built-in `node:sqlite`, so no native compile is needed on Node 22.5+).
- `npm test` → **35 pass / 0 fail**. The commit's "验证 35 pass" claim is therefore **confirmed by execution**, not just by counting `test()` declarations.
- The 35 cases are genuine **server-side enforcement** tests, not client gating: they assert **401/403** on unauthenticated/unauthorized access, **self-only** sign-off (`distribution.js:407`), **approval forced as precondition + self-approval rejected** (`distribution.js:182,186`), **idempotent replay returns the same response**, **stock deduct + `stock_movement` + hash-chain integrity**, and the four "A/B级" fixes (审批鉴权 A-2, 签收假成功 A-3, 审计限权 B-1/B-2). This is the RBAC/AuthZ move from browser to API middleware that §2 called "the single most important security change" — now real.

**Foundation suite — no regression:**
- `node --test tests/engine.test.js` → **13 pass / 0 fail**; `node --test tests/sql.test.js` → **9 pass / 0 fail**.
- **Combined total: 57 tests passing** (13 + 9 + 35), up from the **22** this report originally recorded.

**Re-verified still-open at `a85565d` (unchanged from §10):**
- **D1** — still no deprecation banner on `PROJECT-SOLUTION-DOC.md`.
- **A2** — `grep -ri "CREATE TRIGGER" foundation/migrations/` → **no matches**; append-only on `chain_event`/`stock_movement` is still convention-only.
- **I1** — A-T7 (concurrent step-1 oversell) is asserted in the **in-memory** engine suite but has **no server/SQL-layer equivalent**; true-restart A-T12 is covered for migration replay (`DR-T02-02`) but the distribution path's concurrency is not.
- **G1/G4** — still present in the prototype `index.html` (`handleLogin` still mocks `permissions:['all']` at line 2321); server-side fixes only.
- **DEMAND-POOL** — still 29× 待认领.

**What this changes in the report's verdicts:**
- **A1 / M3 / I2 (superseded):** the architecture is no longer "design only" — a working Fastify + SQLite + session-auth + RBAC server exists, is tested (35/35), and is CI-guarded. The §0 headline "no server, `package.json`, or CI exists" is now historically true only of the `5f6d850` snapshot.
- **Recommendation #2 ("Add CI now") — done.** Recommendation #1 (staff the sprint) — overtaken by delivery. **Recommendation #3 (D1 banner) — still the top open action**, and now the cheapest remaining item.
- **Residual risk shifts from "can they build it?" to "is what they built correct and maintained?"** Concretely: (a) land the **append-only triggers** (A2) so the tamper-evident selling point is DB-enforced, not app-enforced; (b) add a **server-layer A-T7 concurrency test** (I1) to prove no-oversell under real SQLite serialization; (c) reconcile **DEMAND-POOL/DR-SPRINT-TRACKING** with what shipped so the evidence rule isn't undercut; (d) finish the **D1 banner**.

**Overlap note:** the remote also added its own `COMPREHENSIVE-AUDIT-AND-EVOLUTION-PLAN.md` (`84478aa`), whose scope overlaps this report; the C-1/C-2①/C-2②/C-3 labels above come from its numbering. Reconciled in full in **§12** below.

---

## 12. Reconciliation — this report vs `COMPREHENSIVE-AUDIT-AND-EVOLUTION-PLAN.md`

`COMPREHENSIVE-AUDIT-AND-EVOLUTION-PLAN.md` (v1.1, 2026-11-16, 152 lines) has now been **read in full**. **Headline: it is complementary, not contradictory — with one direct conflict and two overstatements to flag.** The two documents attack the problem from opposite ends: this report is a *technical/code* verification of the implementation; the overlap doc is a *strategic/business* audit (positioning, market benchmarks, subsystem selection, roadmap). They barely overlap on code, and where they do, they mostly agree.

### 12.1 What the overlap doc is (scope)
Five sections: (一) current-state audit across goals/domain-fit/technical-feasibility; (二) benchmarking 3 market players (盈峰环境 / 伏泰科技 / Rubicon); (三) two "killer" subsystems (A materials, B snow-emergency); (四) explicit assumptions; (五) 4-stage roadmap. It is a *decision-layer* document — closest in spirit to `PROJECT-SOLUTION-DOC` + the subsystem selection, **not** to this report's line-level code audit. Its §一.3 technical findings were the source of the "A/B级 fix" labels adopted in §10.

### 12.2 Cross-reference table

| Overlap doc claim | This report counterpart | Status |
|---|---|---|
| §一.3 "Caddy 静态共享 localStorage/IndexedDB 是无效的；手机↔PC 必须靠服务端" | A1 / Phase-0 rationale (BroadcastChannel same-browser-only) | **Agree** — identical conclusion, independently reached; this is the strongest shared finding |
| §一.3 "前端鉴权可被绕过" | G4 / A1 (mock `permissions:['all']`) | **Agree** |
| §一.3 "密码明文硬编码" (historic) | Not separately tracked | Agree as historic; **note the default `Aa@123456` bootstrap password is still in SOP-Org-03** (I3) — overlap doc doesn't flag it as a *current* issue |
| §一.3 "单文件上万行难以协作" | M2 (`index.html` 10,807 lines) | **Agree** |
| §一.3 "scrypt 密码加盐哈希" | `server/auth.js:11` uses **`bcryptjs`**, not scrypt | **Divergence (factual error in overlap doc)** — see 12.3 |
| §一.3 "覆盖数百项的单元测试与回归测试集" | Executed count = **57** (13+9+35) | **Overstatement** — see 12.3 |
| §一.3 "better-sqlite3" | `optionalDependencies`; code prefers `node:sqlite` | Minor — it works, but the doc names the optional path as the primary |
| §一.1 "定位摇摆：无后端单机 vs 集团多租户" | D1 (formal doc never reconciled to server-first) | **Agree** — same root cause, different framing |
| §一.2 "强密码/强制改密/5次锁定脱离一线高龄工人实际" | Decision #2 assumed the *opposite* (一线有手机+账号, self-only, no PIN fallback) | **Tension** — see 12.4 |
| §四 假设2.1 "代管原则"（班组长代录入，不假设每人会用手机） | Decision #2 / A-T5 self-only | **Direct conflict** — see 12.4 |
| §三/§五 subsystem A/B + 4-stage roadmap | Sub-system A spec / roadmap phases | **Agree in direction**; overlap doc's B (emergency) is *not* in this report's P1–P4 (deferred to P3 demo/simulator) |
| Does it track **A2** (append-only triggers)? | — | **No** — no mention of DB-enforced tamper-evidence |
| Does it track **I1** (A-T7 concurrency)? | — | **No** — it asserts "防超卖" is done but never names a concurrency test |
| Does it track **D1** (formal-doc banner)? | — | **Partially** — flags "定位摇摆" but proposes no deprecation action |

### 12.3 Two factual overstatements in the overlap doc (code-verified)
1. **Hash algorithm:** §一.3 states "密码加盐哈希（**scrypt**）." The actual code (`server/auth.js:11`) sets `PWD_ALGO = 'bcryptjs'` and calls `bcrypt.hash(plain, 10)`. It is **bcrypt, not scrypt.** Both are salted and acceptable, but the doc names the wrong algorithm — the same class of doc-drift this report keeps catching (D3).
2. **Test volume:** §一.3 claims "覆盖**数百项**的单元测试与回归测试集" (hundreds of tests). The executed, real count across all 8 test files is **57** (13 engine + 9 SQL + 35 server). "数百" overstates by ~4–5×. The 57 are genuinely good tests; they just aren't "hundreds."

### 12.4 One direct conflict to escalate — self-only vs 代管 (the most important item)
- **This report / `foundation/README.md` Decision #2 / A-T5:** asserts every 一线 worker **has a phone + account**, enforces **self-only sign-off** (`signoff.self_only='true'`, `distribution.js:407`), explicitly "no PIN fallback."
- **Overlap doc §一.2 + 假设2.1:** asserts the opposite — workers average **50–65 years old**, "不假设每名保洁员都能熟练使用智能手机完成复杂的账号登录和改密," and prescribes **班组长/车队长代管录入** (leader signs on the worker's behalf) plus "移动端免复杂密码代签."

These are **mutually exclusive controls.** Self-only exists specifically to prevent a supervisor from signing on a worker's behalf (the anti-fraud property the audit chain is built around); 代管 deliberately reintroduces exactly that. **The self-only test suite (A-T5, DR-T05-03) currently locks in self-only**, while the strategy doc prescribes 代管 — meaning either the strategy doc's assumption is wrong, or the implemented control is wrong for the real workforce. This is a **product/requirements decision, not a code bug**, and it must be resolved by Daniel before the pilot: if the real workforce can't self-sign, the whole self-only/anti-fraud chain (A-T5, and the 履约 evidence story built on it) needs rethinking. **This is the single highest-value finding of the reconciliation** — neither document resolved it, and they currently disagree on `main`.

### 12.5 Net
- The overlap doc is **complementary** and worth keeping as the strategic layer; it independently corroborates the two biggest shared findings (server-mandatory, frontend-auth-bypassable).
- **Correct in the overlap doc:** the scrypt→bcrypt error and the "数百项 tests" overstatement (both minor, both fixable in one edit).
- **Escalate:** the self-only vs 代管 conflict (12.4) — a genuine requirements fork that the code and the strategy doc currently answer oppositely.
- **This report's still-open A2/I1/D1 are not tracked by the overlap doc**, so the two documents are *not* redundant — the overlap doc misses all three. Keep this report as the technical-completeness source of truth for those.
- **Recommended action stack is unchanged and now fully evidence-backed:** resolve self-only-vs-代管 (new, highest value) → D1 banner (minutes) → append-only triggers (A2) → server-layer A-T7 (I1) → reconcile DEMAND-POOL with what shipped.

**Net:** the report's #1 risk (execution capacity) was answered in the best possible way — code landed ahead of schedule. The priority stack collapses to: re-run this verification against `a85565d` (especially the new auth/distribution code paths, the correctness of the pushed fixes, and the "35 pass" claim via `npm test`), land the D1 deprecation banner, and reconcile DEMAND-POOL / DR-SPRINT-TRACKING with what actually shipped.