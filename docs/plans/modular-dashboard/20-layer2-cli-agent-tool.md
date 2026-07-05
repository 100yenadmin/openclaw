# L2 — CLI group + agent tools (plugin-side)

**Goal:** humans script the dashboard from a terminal; agents compose it from sessions. Both faces call the SAME validated mutation path as the gateway RPC (one `DashboardStore`). Zero core changes.

**Depends on:** L1 merged. **Read:** `00 §4`, `01-conventions` (shared-store seam, CLI pattern, typebox tools). **Templates:** `extensions/workboard/index.ts` + `src/tools.ts` (tools), `src/cli/cron-cli/register.ts` (subcommand file shape), workboard's `api.registerCli` wiring.

## Files

```
extensions/dashboard/src/cli.ts            # registerDashboardCli — top-level "dashboard" command + subcommands
extensions/dashboard/src/cli.test.ts
extensions/dashboard/src/tools.ts          # createDashboardTools({ api, context, store })
extensions/dashboard/src/tools.test.ts
extensions/dashboard/index.ts              # + wire registerCli / registerTool (constructed store already exists from L1)
```

## CLI (`openclaw dashboard …`)

Registered via `api.registerCli` (workboard model — the plugin self-registers; do NOT touch `src/cli/program/*` core catalogs). Subcommands call `callGatewayFromCli("dashboard.<method>", opts, params)` so CLI traffic flows through gateway auth/scopes like any operator client.

```
openclaw dashboard tabs list
openclaw dashboard tabs create --title "Financials" [--slug financials] [--icon barChart]
openclaw dashboard tabs delete <slug>
openclaw dashboard tabs reorder <slug...>
openclaw dashboard tabs hide|show <slug>
openclaw dashboard widgets list [--tab <slug>]
openclaw dashboard widgets add --tab <slug> --kind builtin:stat-card --title "Q3" [--grid 0,0,4,2] [--binding value=file:q3.json#/revenue] [--props '{"format":"usd"}']
openclaw dashboard widgets update --tab <slug> --id <id> [--title …] [--collapsed true|false] [--hidden …]
openclaw dashboard widgets move --tab <slug> --id <id> --grid x,y,w,h | --to-tab <slug>
openclaw dashboard widgets remove --tab <slug> --id <id>
openclaw dashboard layout get [--json]
openclaw dashboard layout set --file <path.json>      # full workspace.replace after local validation
openclaw dashboard layout undo
openclaw dashboard widget-scaffold <name> [--title …]  # creates <stateDir>/dashboard/widgets/<name>/ template
```

- Output: human table by default (match cron CLI's themed-table helpers), `--json` for machine output on every read.
- `tabs list` / `widgets list` read via `dashboard.workspace.get` and render client-side — there are no separate list RPCs (the 14-method surface is fixed by L1).
- Binding shorthand parser: `value=file:<relpath>[#<json-pointer>]`, `value=rpc:<method>`, `value=static:<json>` — parse in CLI, send structured binding objects.
- `widget-scaffold` writes: `widget.json` (manifest, status auto-`pending` unless invoked by operator CLI → `approved` since the human ran it), `index.html` template demonstrating the bridge (`ready` → `getData` → render + `onData` re-render), and a `README.md` telling the (agent) author the bridge contract. Registry entry via the store.

## Agent tools (`src/tools.ts`)

`createDashboardTools({ api, context, store })`, registered `api.registerTool(factory, { names: [...], optional: true })`. One tool per verb (workboard style), typebox input schemas:

| Tool | Maps to | Notes |
|---|---|---|
| `dashboard_workspace_get` | store read | full doc; agents diff before mutating |
| `dashboard_tab_create` / `dashboard_tab_update` / `dashboard_tab_delete` / `dashboard_tabs_reorder` | store.mutate | |
| `dashboard_widget_add` / `dashboard_widget_update` / `dashboard_widget_move` / `dashboard_widget_remove` | store.mutate | |
| `dashboard_layout_set` | batch grid | `[{id, grid}]` |
| `dashboard_workspace_replace` | full-doc set | bulk authoring; still size/schema-capped |
| `dashboard_widget_scaffold` | scaffold + registry `pending` | ALWAYS `pending` from tools (agent-authored) |
| `dashboard_undo` | store.undo | |
| `dashboard_data_read` | binding resolver | lets the agent see exactly what a widget sees |

- Tools call the store **in-process** (`store.mutate(...)`) — NOT via WS RPC — the workboard seam. Same validation, same broadcast.
- Provenance: `createdBy: "agent:<id>"` derived from the tool context owner (copy workboard's context-owner helper); NEVER accept `createdBy` from tool params.
- Tool descriptions must be written for the agent-author audience: each description states what the verb does, its constraints (slug charset, grid bounds), and points to `dashboard_workspace_get` for current state. This is prompt-surface — keep them tight.

## Acceptance criteria

- [ ] `git diff --stat` touches only `extensions/dashboard/`.
- [ ] Every CLI subcommand round-trips against a running gateway (happy path + one validation-rejection each); `--json` outputs parse.
- [ ] Binding shorthand parser covered by tests (all three sources + pointer + malformed rejects).
- [ ] Tools: schema accept/reject tests per verb; provenance stamped `agent:<id>` and NOT overridable via params; scaffold from tool → `pending`, from operator CLI → `approved`.
- [ ] CLI-vs-tool convergence test: tab created via tool is visible via CLI list and vice versa (same store).
- [ ] A write via tool triggers exactly one `plugin.dashboard.changed` (assert via test broadcast spy).
- [ ] `widget-scaffold` output renders standalone: `index.html` template contains a working bridge stub (message envelope v1) and no external network refs.

## Verification

```
pnpm vitest run extensions/dashboard
pnpm tsgo
# manual: openclaw dashboard tabs create --title Smoke && openclaw dashboard tabs list --json
```

## Out of scope

Any UI rendering (L3/L4), widget HTTP serving/approval UI (L5), descriptor registration (L3 wires it in index.ts alongside these). Est. ~900–1,300 LOC incl. tests.
