# Modular Dashboard — vision & architecture

> Handoff corpus for the agent-composable Control UI dashboard. Any executing agent must read this file and `01-conventions.md` before starting any layer issue. Layer specs: `10-*` … `50-*`; final acceptance: `90-demo-script.md`.

## Why

OpenClaw's Control UI is a fixed set of hand-coded views. Two customers need composability:

1. **Small-business operators** — a business control hub: financial tabs, per-agent workspaces, drag/drop, hide/collapse. They will never edit code.
2. **Maintainers / daily-drivers (currently on Codex)** — mission-control ergonomics: sessions + activity + approvals + cron in one composed view, live previews, fast dispatch. They won't return for a worse Codex — only for something Codex cannot do.

The bet — the thing Codex cannot do: **the agent composes the operator's dashboard itself.** "Give me a financials tab" → the agent creates a tab, adds widgets it authored, binds them to live data — via validated commands, never by editing dashboard source. The human has full drag/drop parity over the same document. The UI is a *living artifact of the collaboration*, not a fixed shell.

Upstream demand already on file: #66138 ("make OpenClaw feel like WordPress" — modular plugin-driven dashboard), #27574 (browser preview panel), #66983/#68497 (agent-rendered UI reachable from browsers), #76089 (spawn sub-agent button), #72545 (exec approvals surface). The contested big-bang dashboard PR #95339 demonstrates the shape upstream rejects; VISION.md caps PRs at ~5K lines, one topic each, and pushes capabilities into plugins.

## Strategy

- **Fork-first**: complete working system on `100yenadmin/openclaw` integration branch `feat/modular-dashboard` (branched from upstream main ≥ `c730d8f1f1`), proven end-to-end via `90-demo-script.md`, THEN split into a staged upstream PR series behind an RFC anchored on the issues above (positioned relative to #77774/#86460 Overview redesigns — those goals become default-workspace *content* — and explicitly NOT #95339's approach).
- **Plugin-maximal**: everything except the bundled workspace view ships in a new bundled plugin `extensions/dashboard`. Core `ui/` gains one bundled plugin-tab view (the exact pattern logbook used in #99930) plus the widget-host components it needs.
- **Lit shell stays.** No framework change. Custom widgets are sandboxed HTML/JS and may use any framework internally.

## Architecture

### 1. Layout-as-data: `workspace.json`

Gateway-owned document at `<stateDir>/dashboard/workspace.json` (state dir via `resolveStateDir()`, default `~/.openclaw`).

```jsonc
{
  "schemaVersion": 1,
  "tabs": [
    {
      "slug": "financials",              // ^[a-z0-9-]{1,40}$ — also the deep-link key
      "title": "Financials",
      "icon": "barChart",                 // Control UI icon name; unknown → generic fallback
      "hidden": false,
      "createdBy": "agent:main",          // provenance: "user" | "system" | "agent:<id>"
      "widgets": [
        {
          "id": "w_rev_q3",               // unique within doc
          "kind": "builtin:stat-card",    // "builtin:<name>" | "custom:<name>"
          "title": "Q3 Revenue",
          "grid": { "x": 0, "y": 0, "w": 4, "h": 2 },   // 12-col grid units
          "collapsed": false,
          "bindings": {
            "value": { "source": "file", "path": "q3.json", "pointer": "/revenue" }
          },
          "props": { "format": "usd" }
        }
      ]
    }
  ],
  "widgetsRegistry": {                     // custom widgets install/approval state
    "revenue-chart": { "status": "approved", "approvedBy": "user", "approvedAt": "…", "createdBy": "agent:main" }
  },
  "prefs": { "tabOrder": ["main", "financials"] }
}
```

Rules (enforced in the plugin store, single source of truth):
- Atomic writes (`replaceFileAtomic`), async-mutex-serialized mutations, serialized-size cap 256 KB, per-tab widget cap (24) and tab cap (32).
- `schemaVersion` migrations on read; reject future versions.
- Undo: ring of last 20 serialized docs under `<stateDir>/dashboard/undo/`; `dashboard.workspace.undo` restores newest.
- Every mutation validated by hand-written guards (repo idiom — no zod at the RPC layer); invalid ops rejected whole (no partial application).
- Every successful write broadcasts `plugin.dashboard.changed` `{ workspaceVersion, changedTabSlug?, actor }` — all connected operator UIs live-update.

### 2. Widget kinds

- **`builtin:*`** (trusted, rendered as Lit templates inside the Control UI): `stat-card`, `markdown`, `table`, `iframe-embed`, plus data widgets `sessions`, `usage`, `cron`, `instances`, `activity`. Thin renders against gateway read RPCs — deliberately NOT reusing existing page view functions (welded to their pages).
- **`custom:<name>`** (untrusted, agent/user-authored): a directory `<stateDir>/dashboard/widgets/<name>/` containing `widget.json` manifest + `index.html` (+ assets). Rendered in a sandboxed iframe. `<name>` charset `^[A-Za-z0-9._-]+$`.

`widget.json` manifest:
```jsonc
{
  "schemaVersion": 1,
  "name": "revenue-chart",
  "title": "Revenue Chart",
  "entrypoint": "index.html",
  "bindings": [ { "id": "rev", "source": "file", "path": "q3.json" } ],
  "capabilities": ["data:read"],          // "data:read" | "prompt:send"
  "preferredSize": { "w": 6, "h": 4 }
}
```

### 3. Bindings, not fetches

Widgets declare data sources; they never fetch:
- `rpc`: an **allowlisted** gateway read method (initial allowlist: the read methods the builtin data widgets use — sessions/usage/cron/instances/activity reads). Allowlist lives in the plugin, enforced server-side in `dashboard.data.read`.
- `file`: JSON/CSV/markdown **only under `<stateDir>/dashboard/data/`** (path-jailed server-side). The agent workflow: finance agent writes `data/q3.json` → bound widgets update on the next broadcast/poll.
- `static`: literal value in `props`.

### 4. One control plane, three faces

All mutations funnel through ONE `DashboardStore` instance (the workboard shared-store seam):
- **Gateway RPC** `dashboard.*` (scopes `operator.read` for reads, `operator.write` for writes) — used by the Control UI and CLI.
- **CLI** `openclaw dashboard …` — plugin-registered CLI calling the RPC.
- **Agent tools** `dashboard_*` (typebox schemas) — call the store **in-process** (same validation + broadcast), stamped with `createdBy` provenance from the tool context.

The agent and the human converge on the same guarded document. No path writes `workspace.json` directly.

### 5. Surface: one plugin tab, workspace tabs inside

The plugin registers ONE Control-UI tab descriptor (`api.session.controls.registerControlUiDescriptor({ surface:"tab", id:"workspaces", label:"Workspaces", group:"control", requiredScopes:["operator.read"] })`) — projected into hello `controlUiTabs` and rendered by the plugin page. The Control UI adds a **bundled view** for `dashboard/workspaces` (the exact `BUNDLED_TAB_VIEWS` mechanism logbook shipped in #99930).

Inside that view: our own tab strip rendered live from `workspace.json` (deep-linkable via query param on the `/plugin` route, e.g. `?plugin=dashboard&id=workspaces&ws=financials`), then the widget grid for the active workspace tab: CSS grid (12 columns), drag/drop + resize (hand-rolled pointer events — lean-deps, no gridstack), collapse/hide, per-cell error boundary (a broken widget shows an error card in its own cell; the shell never breaks).

Because hello `controlUiTabs` is projected per-connection, individual workspace tabs are NOT separate sidebar entries in wave 1. (Future upstream enhancement, out of scope: a descriptor re-projection event for live sidebar tabs.)

### 6. Custom-widget sandbox (security model — read carefully)

- **Rendering**: `<iframe sandbox="allow-scripts">` — NEVER `allow-same-origin`, never anything else. The iframe's origin is opaque (`null`).
- **Asset serving**: plugin HTTP route with `auth: "plugin"` (unauthenticated by design — sandboxed frames have no device token). Therefore this route serves ONLY static files from the widget's own directory: charset-validated name, logical-path normalization, containment check, correct Content-Type, strict `Content-Security-Policy` header. It never serves data, never accepts writes.
- **Data plane = bridge only**: the child posts `getData(bindingId)`; the PARENT (authenticated Control UI) resolves it via `dashboard.data.read` over its gateway socket and posts the result back. The child never holds credentials and never talks to the gateway.
- **postMessage protocol** (versioned envelope `{ v:1, type, … }`):
  - child→parent: `dashboard:ready`, `dashboard:getData {requestId, bindingId}`, `dashboard:getTheme {requestId}`, `dashboard:sendPrompt {requestId, text}`
  - parent→child: `dashboard:data {requestId, bindingId, data}`, `dashboard:push {bindingId, data}`, `dashboard:theme {requestId, tokens}`, `dashboard:error {requestId, code, message}`
  - Parent accepts messages ONLY when `event.source === iframe.contentWindow` (identity check — origin string is `null` for sandboxed frames) and `type` is known. Parent posts with targetOrigin `"*"` but only payloads listed above (no secrets by construction).
  - `dashboard:sendPrompt` requires `capabilities` to include `prompt:send` AND a parent-side operator confirm dialog per invocation.
- **Approval**: a custom widget scaffolded by an agent enters `widgetsRegistry` as `status:"pending"`. Pending widgets render a placeholder card (name, author, Approve/Reject) — the iframe is NOT created. Approval raises through the existing plugin-approvals flow and/or the placeholder's Approve button → `dashboard.widget.approve` (WRITE) → re-broadcast. Only `status:"approved"` widgets ever get an iframe.

### 7. Theming

`dashboard:getTheme` returns the Control UI's CSS custom-property tokens (accent, bg, card, border, radius, fonts) so agent-authored widgets match the active theme (including #99289's warm light palette). Builtins use the tokens natively.

## Non-goals (wave 1)

- Electron/desktop wrapper (the shell stays a pure gateway-client SPA; wrapping is packaging work later).
- A2UI as widget substrate (experimental, native-nodes-only today) — candidate later widget kind.
- Migrating existing static pages into workspaces; mobile drawer behavior; per-workspace sidebar entries (needs descriptor re-projection — future core PR).
- `command:` binding source (run a script on interval) — explicitly deferred pending security review.

## Upstream split map (post-demo)

| Fork layer | Upstream PR | Closes/anchors |
|---|---|---|
| L1+L2 backend/CLI/tools (plugin only) | PR1 "dashboard plugin: workspace document + control plane" | RFC |
| L3 bundled workspace view | PR2 "Control UI: workspaces bundled plugin tab" | #66138 |
| L4 builtin widgets + default workspace | PR3 | #77774/#86460 supersession, #72545/#76089 partials |
| L5 custom widget host | PR4 | #66983/#68497 (web), #27574 partial |

Each ≤ ~2-3K lines, one topic, independently valuable, per VISION.md.
