# 环卫·清雪智慧运营管理平台 (Sanitation & Snow-Clearing Smart Operations Platform)

A field-operations management platform for municipal sanitation and snow-clearing crews — materials/warehouse chain-of-custody, RBAC, offline-tolerant mobile sign-off, and a tamper-evident audit trail.

> **Status:** active development. Dry-Run (§A) and P0 foundation are delivered; P1 Sub-system A is through Gate-1 (A-T1…A-T14). See [DEMAND-POOL.md](DEMAND-POOL.md) for task status and [ROADMAP-EXECUTION-PLAN.md](ROADMAP-EXECUTION-PLAN.md) for the plan.

## Architecture (one paragraph)

A single **Fastify** app server (Node 22.5+) backed by **SQLite** (WAL) holds all authoritative state; **Caddy** serves the static front-end (`index.html`, `mobile-sign.html`) and reverse-proxies `/api/*` to the app — same-origin, so no CORS and Service Workers register. Auth is session-cookie + bcrypt; authorization is a server-enforced three-factor RBAC model (module × action × data-scope). Every stock change writes an append-only `stock_movement` ledger row, and every state change writes a hash-chained `chain_event` row — both DB-enforced append-only.

## Repository layout

```
├── server/                 Fastify app + SQLite data layer + tests
│   ├── server.js / app.js  entry + app wiring (/healthz, routes)
│   ├── auth.js             session auth, bcrypt, lockout, RBAC principal
│   ├── distribution.js     materials distribution / requisition chain
│   ├── reports.js rental.js  reports + rental ledger
│   ├── db.js               SQLite open + numbered-migration runner
│   └── *.test.js           node:test suite (137 tests)
├── foundation/
│   ├── migrations/         numbered SQL migrations (001…010), auto-discovered
│   └── tests/              in-memory (engine) + real-SQLite (sql) acceptance tests
├── index.html              web admin (prototype UI, in-memory — see note below)
├── mobile-sign.html        field sign-off page (talks to the server)
├── Caddyfile               same-origin static + /api reverse proxy (:8790 → :8791)
├── DEPLOYMENT.md           30-minute bring-up on a LAN box
└── docs/ + *.md            specs, roadmap, audit & verification reports
```

## Quick start (server + tests)

```bash
# 1. Run the test suite (no DB needed; Node 22.5+ for built-in node:sqlite)
cd server && npm install && npm test        # 137 tests

cd ../foundation && node --test tests/engine.test.js   # 13 in-memory
                                    node --test tests/sql.test.js      # 9 real-SQLite

# 2. Bring up the stack on a LAN box
#    see DEPLOYMENT.md — Caddy (:8790) → Fastify (:8791) → SQLite file
cd server && npm start
```

Requires **Node 22.5+** (uses the built-in `node:sqlite`; no native compile). CI runs the server suite + both foundation suites on Node 22 and 24 (`.github/workflows/ci.yml`).

## Key documents

| Doc | What it is |
|---|---|
| [PROJECT-SOLUTION-DOC.md](PROJECT-SOLUTION-DOC.md) | Solution/SOP overview — **read the deprecation banner first** (persistence/backend sections are superseded) |
| [PHASE0-BACKEND-RBAC-ARCHITECTURE.md](PHASE0-BACKEND-RBAC-ARCHITECTURE.md) | Server + RBAC + offline-replay reference architecture |
| [SUBSYSTEM-A-MATERIALS-SPEC.md](SUBSYSTEM-A-MATERIALS-SPEC.md) | Materials/warehouse chain-of-custody spec + acceptance tests |
| [ROADMAP-EXECUTION-PLAN.md](ROADMAP-EXECUTION-PLAN.md) | Gated delivery plan (Gate-DR → 0 → 1 → 2 → 4 → Go/No-Go) |
| [DEMAND-POOL.md](DEMAND-POOL.md) | Task board with per-task acceptance criteria + evidence |
| [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md) | Independent technical verification (5 dimensions) + addenda |
| [DEPLOYMENT.md](DEPLOYMENT.md) | LAN deployment runbook |

## A note on the prototype UI

`index.html` is the original single-file, in-memory prototype (all state lost on refresh, mock login). The **server** is the system of record now; `index.html` remains as the rich web UI shell and is slated for progressive split/re-wiring (see the split assessment). Don't treat its in-memory data as persistent.

## Contributing

Status changes on the task board follow the project's evidence rule: **only commits / test output change a task's status.** Run the suite before pushing; CI gates PRs.

## License

[MIT](LICENSE)
