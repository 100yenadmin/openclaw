# Demo script — end-to-end acceptance (final QA gate)

Run after L5 merges to `feat/modular-dashboard`. Every step must pass. This is the "agent builds your dashboard" proof — record a screen capture of steps 2–7 for the upstream RFC.

## Setup

1. Build: `pnpm install && pnpm build` (repo root; Control UI assets auto-build via the gateway if missing — force with `pnpm ui:build`).
2. Start the gateway locally with the `dashboard` plugin enabled; open the Control UI in a browser (Chrome via automation tooling for verification runs; never rely on manual-only checks).
3. Confirm the sidebar shows the **Workspaces** tab (plugin descriptor advertised in hello).

## Script

| # | Action | Expected |
|---|--------|----------|
| 1 | Open Workspaces tab | Default `main` workspace renders: usage stat cards, sessions table, cron list, activity feed — live data |
| 2 | In chat, ask the agent: *"Create a Financials tab with a revenue stat card bound to dashboard data file q3.json, and a notes widget."* | Agent calls `dashboard_tab_create` + `dashboard_widget_add`; **the tab strip updates live in the already-open browser** (no reload) |
| 3 | `echo '{"revenue": 41250}' > <stateDir>/dashboard/data/q3.json` (as the agent or shell) | Stat card shows $41,250 on next data push/poll |
| 4 | Ask the agent to scaffold a custom widget: *"Build me a custom revenue-chart widget for the Financials tab."* | `dashboard_widget_scaffold` creates `<stateDir>/dashboard/widgets/revenue-chart/`; widget appears as **pending-approval placeholder** (NO iframe yet) |
| 5 | Click Approve on the placeholder | Iframe renders sandboxed (`sandbox="allow-scripts"`, no `allow-same-origin` — verify attribute in DOM); chart draws from bridge `getData` |
| 6 | Update `q3.json` again | Custom widget updates via `dashboard:push` without reload |
| 7 | Drag the stat card to a new grid position; collapse the notes widget; hide the tab from the tab-strip menu; then ask the agent *"what's on my Financials tab and where?"* | Layout persists (reload → same); agent's `dashboard_workspace_get` reflects the human's drag/collapse/hide accurately |
| 8 | `openclaw dashboard tabs list` / `widgets list --tab financials` from a terminal | CLI output matches UI state |
| 9 | `openclaw dashboard layout undo` | Last mutation reverts, UI live-updates |
| 10 | Break test: edit the custom widget's `index.html` to `throw` on load | Only that cell shows an error card; shell, other widgets, other tabs unaffected |
| 11 | Security spot-checks | (a) In devtools, from the widget iframe console: `fetch('/api/…')`/gateway WS attempt fails (no credentials, opaque origin); (b) widget asset URL with `../` traversal → 404; (c) `dashboard:sendPrompt` from the widget → operator confirm dialog appears; deny → nothing sent |
| 12 | Open the Control UI in a second browser/profile | Same workspace state (server-side doc, not localStorage) |

## Pass criteria

All 12 rows green, plus: `pnpm tsgo` (or repo's typecheck task) clean, UI unit + browser + mocked-gateway E2E suites green, `pnpm ui:i18n:check` clean. Capture: screenshots per row, plus the recording for rows 2–7.
