# L4 — Built-in widgets + default workspace

**Goal:** the trusted widget library that makes workspaces useful on day one, and the default `main` workspace that replaces "Overview-as-code" with "Overview-as-data". After L4, the small-business persona works end-to-end with safe parts (no custom code anywhere).

**Depends on:** L3 (grid + registry seam), L1 (`dashboard.data.read`). **Read:** `00 §2-3`, `01-conventions`.

## Widget set

Registered in `ui/src/lib/dashboard/widgets/` (one module per widget + a registry index consumed by L3's dispatch):

| Kind | Renders | Data |
|---|---|---|
| `builtin:stat-card` | big number + label + optional delta | one binding (`value`), `props.format` (`usd`\|`int`\|`percent`\|`raw`) |
| `builtin:markdown` | markdown body (reuse the repo's existing markdown render util in `ui/src/lib` — locate current path at build time) | binding `content` (file/static) |
| `builtin:table` | compact table, first N rows + count footer | binding `rows` (file JSON array / rpc) with `props.columns` picklist |
| `builtin:iframe-embed` | embedded URL (dev-server preview, hosted report) | `props.url`; sandbox via `resolveEmbedSandbox(config.embedSandboxMode)`; external http(s) URLs blocked unless the existing external-embed config allows (mirror chat embed policy exactly — `ui/src/app/config.ts`) |
| `builtin:sessions` | latest-N sessions, live-run dot, click → chat (reuse existing session-row affordances if cheaply importable; else minimal list + link) | rpc |
| `builtin:usage` | today/window cost + tokens mini-summary | rpc |
| `builtin:cron` | next runs + last status per job | rpc |
| `builtin:instances` | connected instances + health | rpc |
| `builtin:activity` | recent activity feed (compact) | rpc |

Implementation rules:
- Data widgets are **thin re-implementations** against read RPCs resolved through the L3 controller **directly on the page's gateway client** (SETTLED 2026-07-06, issue #3: `dashboard.data.read` cannot proxy rpc — plugin gateway handlers can't dispatch other methods; it serves `file`/`static` only, and rpc resolution is client-side everywhere, builtins and bridge alike). Do NOT import existing page view functions — they're welded to their pages' state.
- **Exact RPC method names:** enumerate at build time from the existing pages (sessions/usage/cron/instances/activity pages' controllers show the read methods + payload shapes) and freeze them into `DATA_READ_RPC_ALLOWLIST` in the plugin (L1 exported const — extend it in the same PR if the final builtin set needs more; allowlist changes are plugin-side only).
- Refresh: piggyback on `plugin.dashboard.changed` refetch for doc changes; data refresh per-widget on visibility + a modest interval (30–60s default, `props.refreshSeconds` clamp ≥10) — match logbook's polling hygiene (stop on tab switch/disconnect).
- Every widget: loading skeleton, empty state, error state (inside the cell — never throw past the boundary).

## Default workspace (`extensions/dashboard/src/default-workspace.ts`)

Tab `main` ("Overview"), `createdBy:"system"`:
- Row 1: `usage` stat-cards (cost today, tokens today) + `instances` health card.
- Row 2: `sessions` (w=6) + `cron` (w=6).
- Row 3: `activity` (w=12, h taller).
Layout must read well at 1280px and degrade to single-column below ~900px (grid module handles reflow; verify visually).

A seeded example second tab is NOT shipped (keep first-run clean); the demo script creates Financials live instead.

## Acceptance criteria

- [ ] All 9 builtins render with mocked data in the E2E harness; each shows loading/empty/error states.
- [ ] Data-shape mapping unit tests per widget (given RPC payload fixture → rendered model).
- [ ] `iframe-embed` respects `embedSandboxMode` and the external-URL policy (tests for strict/scripts/trusted × internal/external URL).
- [ ] Default workspace seeds on fresh state dir and visually matches the layout above (screenshot in PR, light+dark).
- [ ] Polling stops when the Workspaces tab is left (no orphan timers — copy logbook's stop discipline; test it).
- [ ] `DATA_READ_RPC_ALLOWLIST` updated in the same PR if builtins added methods; allowlist test updated.

## Verification

```
cd ui && pnpm test && pnpm ui:i18n:check && pnpm ui:build
pnpm vitest run extensions/dashboard      # allowlist/default-workspace tests
# E2E dashboard scenarios extended with per-widget fixtures
```

## Out of scope

Custom widgets (L5). New chart library (NO chart dep in wave 1 — stat-card/table cover it; a chart widget kind is a future addition or a custom widget). Est. ~1,100–1,500 LOC incl. tests.
