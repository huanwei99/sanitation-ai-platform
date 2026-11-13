# Phase 0 — Backend, RBAC & Offline-Sync Reference Architecture

Foundation for Sub-system A (and every later module) · Draft v0.1 · Owner: TBD

This is the prerequisite the audit and the Sub-system A spec both call for. It replaces the prototype's **browser-only, mock-auth, in-memory** posture with a **server-backed, offline-tolerant, RBAC-enforced** foundation — while **reusing the project's own RBAC design** from `platform-upgrade-plan.md` rather than inventing a new one.

---

## 1. Why this exists (the blocker it removes)

The upgrade plan's "real-time" strategy is `BroadcastChannel` — which the plan itself notes is **同浏览器多 Tab 实时同步** (same-browser, multi-tab only). The audit confirmed the consequence: a 保洁员/班组长 signing on a **phone in the field** can never reach the office PC without a server as source of truth. The plan's IndexedDB + Caddy same-origin deployment fixes *sharing within one browser*, not *across devices*. So for the product's core scenario (field sign-off), a server is **mandatory, not optional**.

Phase 0 therefore delivers exactly four things, nothing more:

1. **Persistence** — a real DB (replaces in-memory arrays lost on refresh).
2. **AuthN** — real login (replaces mock `permissions:['all']`).
3. **AuthZ** — the existing three-factor RBAC, enforced **server-side**.
4. **Offline-tolerant sync** — mobile writes queue locally and replay.

---

## 2. Deployment topology (grounded in their constraints)

Constraints from the repo: **Windows environment**, locked-down government/SOE LANs, the plan already recommends a **Caddy single-binary** same-origin server, "zero-infra / offline" is the de-facto differentiator.

```
                    ┌──────────────────────────────────────────┐
  Office browser ──▶│  Caddy (single .exe, same-origin)        │
  Field phone ─────▶│   • serves index.html / mobile.html      │
  Depot tablet ────▶│   • reverse-proxies /api/* → App         │
                    │   • auto-HTTPS on LAN (internal CA)      │
                    └───────────────┬──────────────────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  App server        │   Node 20 + Fastify (JS, matches team)
                          │  (single process)  │   or Python FastAPI
                          │  • REST /api/v1    │
                          │  • RBAC middleware │
                          │  • chain_event log │
                          └─────────┬─────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  SQLite (WAL)      │   single-file, zero-ops
                          │  /warehouse.db     │   nightly backup to disk
                          └────────────────────┘
```

**Pilot stance:** single project company, single depot, LAN-only. One app-server process + one SQLite file. No containers, no cluster, no managed cloud — matching the "works on a locked-down LAN" reality. (The formal doc's later "Docker" phase is out of scope for Phase 0.)

**Why SQLite first:** zero-ops, single-file, survives on a Windows box with no DBA, and comfortably handles the scale (18 employees, hundreds of issuance rows). Postgres is the upgrade path if/when it goes multi-project/multi-tenant — the data model in the Sub-system A spec is written to be portable to Postgres unchanged.

---

## 3. Tech stack (pragmatic, minimal new skills)

| Layer | Choice | Rationale |
|---|---|---|
| App server | **Node 20 + Fastify** (alt: Python FastAPI) | Team already writes JS; one language across client+server lowers the bar |
| DB | **SQLite (WAL mode)** via `better-sqlite3` | Zero-ops, single-file, LAN-friendly; portable to Postgres |
| Auth | **Session cookie** (HttpOnly, Secure, SameSite=Lax) | Simplest secure option on a same-origin LAN; no JWT complexity for pilot |
| Passwords | **bcrypt/argon2** | Replaces mock login |
| Static + proxy | **Caddy** | Already recommended in the plan; same-origin kills CORS pain, enables Service Worker |
| Mobile offline | **IndexedDB queue + Background Sync** | Reuses plan's PWA direction, but syncs to the **server**, not just same-browser tabs |
| Migrations | **Numbered SQL files** (`migrations/001_*.sql`) | Auditable, replayable schema history |

---

## 4. RBAC — reuse their model, enforce it server-side

The upgrade plan already defines a clean **three-factor permission model**. Phase 0 keeps it **byte-for-byte in spirit** but moves enforcement from the browser (where `hasPermission()` lives today and can be bypassed) to an **API middleware**. This is the single most important change.

### 4.1 The three factors (unchanged from the plan)
```
permission = module(menu) × action × data-scope

actions:  view | edit | export | admin
scopes:   self | team | dept | project | region | group
levels:   L1 决策层 · L2 管理层 · L3 执行管理层 · L4 基层管理 · L5 一线
          (+ 职能岗位: low level, wide module scope)
```

### 4.2 Server-side principal & permission record
Mirror the plan's `employee.permissions` shape as the server's authority:
```jsonc
// employees table + permissions (JSON) — same semantics as the plan
{
  "employee_id": 11,
  "mode": "auto",              // auto=role template | manual=override
  "level": 3,                  // L1..L5
  "scope": "project",
  "modules": { "materials": ["view","edit"], "approvals": ["view","admin"], "...": [] },
  "admin_level": 0,            // 0=none,1=project,2=region,3=HQ admin
  "granted_by": 4, "granted_at": "2026-11-11"
}
```

### 4.3 Enforcement middleware (the port of `hasPermission`)
```
every /api/v1/* request:
  1. resolve principal from session cookie        (AuthN — 401 if none)
  2. hasPermission(module, action, target?)       (AuthZ — 403 if false)
     • admin_level >= 3 → allow (same as plan)
     • module/action must be in perm.modules (ALL wildcard preserved)
     • data-scope check via isWithinScope(self|team|dept|project|region|group)
  3. route handler
```
`isWithinScope` is ported directly from the plan (`me.id/teamId/department/projectId/regionId` comparisons). For Sub-system A, the extra **self-only** rule on recipient sign-off (spec §4.1, A-T5) is enforced *in addition* to scope — scope alone would let a 项目-level manager sign a worker's receipt, which the audit forbids.

### 4.4 Hierarchical authorization (unchanged rules)
Port the plan's **只能向下授权，不能向上修改；同级别互不干涉**:
- `admin_level=3` (HQ) sets anyone, appoints `=2`.
- `=2` (region) sets own company + downstream, appoints `=1`, cannot touch HQ.
- `=1` (project) sets own project only, cannot modify superiors or appoint higher.
Enforce in the permission-write endpoint, not just the UI.

### 4.5 Seeding
On first boot, seed the L1–L5 role templates + the 职能岗位 wide-scope template from the plan, then assign per-employee. This gives an immediately usable permission matrix instead of a blank slate.

---

## 5. Offline-tolerant sync (the part BroadcastChannel can't do)

Applies to **writes from the field**: Sub-system A sign-offs (`signoff`), transfers (`transfer`). Reads are cached, writes are queued.

### 5.1 Client queue
- Mobile client (Service-Worker PWA, served over Caddy HTTP so SW registers) keeps an **outbox** in IndexedDB.
- Each queued write captures: `{idempotency_key, endpoint, payload, actor_id, captured_at (client clock), server_endpoint_version}`.
- When online → replay in order. When offline → accumulate.

### 5.2 Server replay contract
- Every mutating endpoint accepts an **`Idempotency-Key`** header; the first request stores the result, replays return the stored result (no double stock deduction, no double sign-off).
- Step transitions use **optimistic locking** on `current_step` → a stale replay gets `409` and is dropped client-side (already satisfied).
- Sign-off is **self-only + idempotent** → reconnect replays are safe no-ops.

### 5.3 Conflict rules for Sub-system A (all monotonic → safe)
| Operation | Conflict behavior |
|---|---|
| Recipient sign-off | recipient `待接收→已移交→已接收` is monotonic; replay of an already-`已接收` recipient = no-op success |
| Partial transfer | set of transferred recipients grows monotonically; union on replay |
| Stock deduction | happens **only server-side** at step1 (clients never write stock) → no client conflict possible |
| Step completion | first confirmed server write wins; later replays for the same step are no-ops |

**Design principle:** push *all* authoritative computation (stock math, step advancement, validation) to the server; the client only captures *intent* (a sign-off, a transfer selection). This is what makes offline safe — the field device never owns state, it only reports events.

---

## 6. Data migration (prototype → DB)

- Seed the DB from the current in-memory arrays (`inventoryItems`, `inboundRecords`, `outboundRecords`, `materialDistributions`, `materialRequisitions`, `workUnits`, `employees`) via a one-time `scripts/seed-from-prototype.js`.
- **Normalize as you migrate** (per Sub-system A spec §3): introduce `stock_movement` ledger, `chain_event` audit log; convert yuan-float costs to minor units (分).
- Keep `employee_id` as the FK spine so the existing cross-module drill-down (`employeeLink` / `showEmployeeDetail`) keeps working unchanged.
- The **orphaned `js/app.js` + `js/data.js`** are the superseded second implementation — do **not** migrate from them; delete them (audit hygiene item) so there's one source of truth.

---

## 7. AuthN — replacing the mock login

- `POST /auth/login` (username/email + password) → verify bcrypt/argon2 hash → set session cookie.
- `POST /auth/logout` → destroy session.
- `GET /auth/me` → current principal + effective permissions (drives client UI gating, but **never** the authority — server re-checks every call).
- Remove the hard-coded "any credentials → 李明 `permissions:['all']`" path.
- Password policy + account lockout after N failures (baseline).

---

## 8. API surface (Phase 0 slice, in addition to Sub-system A's §6)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` / `/auth/logout` | Session auth |
| GET | `/auth/me` | Principal + effective perms |
| GET | `/employees` / `/{id}` | Directory (scope-filtered) |
| GET/PUT | `/employees/{id}/permissions` | Permission matrix (hierarchical-authz enforced) |
| GET | `/roles` | L1–L5 + 职能 templates |
| GET | `/work-units` | `workUnits` (for recipient derivation) |
| GET | `/sync/outbox-ack` | (optional) ack replayed keys |

Sub-system A adds `/inventory`, `/inbound`, `/distributions`, `/requisitions`, `/events`, `/reports/*` per its spec §6.

---

## 9. Observability, backup, ops (baseline, not gold-plating)

- **Backup:** nightly `sqlite3 .backup` to a dated file; retain 7–30 days (the plan's backup instinct, moved server-side). Verify restore quarterly.
- **Audit:** `chain_event` is the tamper-evident trail (hash-chained per Sub-system A spec §3.8) — this doubles as the security audit log.
- **Logging:** structured request logs (who/what/when/status) to a rotating file. No external APM for pilot.
- **Health:** `GET /healthz` for Caddy/Caddyfile or a watchdog.
- **Updates:** numbered migrations run on boot; a deploy = swap binary + restart.

---

## 10. Explicit assumptions (Phase 0)

1. **Single-tenant, single-depot pilot** — no multi-project isolation needed yet. Multi-tenancy is deferred; the data model carries an implicit `project_id` (via employee/project scope) so it can be added without a rewrite.
2. **LAN-only deployment** — no public-internet exposure for the pilot. If it must be internet-reachable, add a reverse proxy with TLS + rate-limiting and revisit session/auth hardening (out of scope here).
3. **Field workers have a phone + account** (or a depot tablet with per-worker PIN) — required for the self-only sign-off control (spec A-T5). If not, that control needs a PIN-per-worker fallback.
4. **One app-server process is sufficient** for ≤100 concurrent users on a LAN. No horizontal scaling designed.
5. **SQLite WAL is adequate** for this write volume; revisit → Postgres only if multi-depot/multi-tenant concurrency appears.
6. **Team can run a Node (or Python) process on Windows** — the plan assumed "no backend," so this is a real capability shift; if truly unavailable, the fallback is a minimal server the plan itself hints at ("PHP 单文件"), but a JS/Python process is the recommended path.
7. **Government LAN allows a locally-hosted HTTP service** on a depot PC. If policy forbids even that, the offline-only demo remains the ceiling (and cross-device sign-off is impossible — reconfirm before investing).
8. **PII/个人信息保护法** handling (retention, access scope, encryption-at-rest) is designed-for (RBAC + audit + scope) but **not fully mapped** — a compliance workstream to complete before production.

---

## 11. Build order & rough effort

| Step | Deliverable | Rough effort |
|---|---|---|
| 0.1 | App-server skeleton + Caddy same-origin + `/healthz` | S |
| 0.2 | SQLite schema (migrations) + seed-from-prototype | M |
| 0.3 | AuthN (login/logout/me, bcrypt, sessions) | S |
| 0.4 | RBAC middleware (3-factor + hierarchical write rules) | M |
| 0.5 | Offline outbox + `Idempotency-Key` replay on mutating endpoints | M |
| 0.6 | Sub-system A endpoints (spec §6) on top | M–L |
| 0.7 | Acceptance tests A-T1…A-T12 (spec §8) | M |

(S/M/L = small/medium/large; not calendar dates — sequencing only.)

**Sequence guardrail:** 0.1–0.5 are the non-negotiable foundation. Sub-system A's endpoints (0.6) and its acceptance tests (0.7) come **only after** 0.4 (RBAC) and 0.5 (idempotency) exist — otherwise the audit-grade controls (A-T2, A-T5, A-T6) have nothing to stand on.

---

## 12. What Phase 0 deliberately does NOT do

- No real-time GPS/telemetry (Sub-system C).
- No performance scoring (Sub-system B).
- No multi-tenant billing/subscription layer.
- No public-cloud/Internet deployment.
- No live 城运平台 interface (only data-shaped-for-later).
- No rewrite of the `index.html` UI — it stays the front-end; Phase 0 re-platforms what's *behind* it.
