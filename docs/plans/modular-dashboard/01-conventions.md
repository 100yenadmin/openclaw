# Conventions & verified seams — executing-agent contract

Read this before touching code. It encodes the repo idioms your PR will be reviewed against, and the exact seams the layer specs build on.

## Ground rules

1. **Upstream velocity discipline.** This corpus was verified against upstream/main `c730d8f1f1` (2026-07-05). Line numbers WILL drift; file paths are stable-ish. Before relying on any seam: re-verify it exists at your HEAD (one grep). If a seam moved structurally, follow the pattern-by-name, note the delta in your PR description, and update this doc in the same PR.
2. **Zero core changes except where a layer spec explicitly lists them** (only L3 touches `ui/`; L1/L2/L5 are `extensions/dashboard/` only — enforce with `git diff --stat`).
3. **Lean deps.** Do not add npm dependencies to `ui/` or the plugin without a spec saying so (drag/drop is hand-rolled; no gridstack/interact.js/zod).
4. **One layer = one PR to `feat/modular-dashboard`**, commits grouped logically; i18n regeneration and any sidebar-adjacent edit isolated into their own commits.
5. **No hand-edits to generated i18n locales** (`ui/src/i18n/locales/*` non-English, `ui/src/i18n/.i18n/*`). English source: `ui/src/i18n/locales/en.ts`; then `pnpm ui:i18n:sync` and commit regenerated bundles (`ui/AGENTS.md` is authoritative).
6. **Tests accompany every unit** — copy the co-located `*.test.ts` style of the template you're imitating. Local test runs are fine; heavy suites can go to fork CI.

## Verified seam table (upstream/main c730d8f1f1)

| Seam | Where | Note |
|---|---|---|
| Plugin gateway method registration | `src/plugins/registry.ts:772-806` (`registerGatewayMethod`) | scope normalized; descriptors feed `src/gateway/method-scopes.ts` authorization |
| Handler context incl. `broadcast` | `src/gateway/server-methods/shared-types.ts:86` (fn), `:181` (`GatewayRequestHandlerOptions.context`) | broadcast from ANY handler: `opts.context.broadcast(event, payload)` |
| `plugin.*` event delivery | `src/gateway/server-broadcast.ts:23` (EVENT_SCOPE_GUARDS), `:72-79` | unlisted `plugin.*` events delivered to `operator.write`/`admin` operator clients |
| Shared-store seam (store → methods+tools+CLI) | `extensions/workboard/index.ts:8-30` (+ `runtime-api.ts` barrel) | ONE store instance; gateway methods via barrel re-export; `registerTool` :16, `registerCli` :16-30 |
| Gateway method idiom (manual validation) | `extensions/workboard/src/gateway.ts:8-13` (respondError/types), `:23-37` (`readId`/`readPatch`), `:82-99` (scoped registrations) | copy this style; NO zod at RPC layer |
| Agent tool registration + typebox schemas | `extensions/workboard/src/tools.ts` (`Type` from "typebox"; one tool per verb; provenance from tool context) | |
| Plugin CLI registration | `extensions/workboard/index.ts:16-30` (`api.registerCli`); subcommand file pattern `src/cli/cron-cli/register.ts:14-31` | CLI → gateway via `callGatewayFromCli` `src/cli/gateway-rpc.ts:32-47` |
| Plugin HTTP routes + auth tiers | `src/gateway/server/plugins-http/route-auth.ts:12-16` | `auth:"plugin"` = UNAUTHENTICATED; `auth:"gateway"` = device-token-gated. Canvas registers at `extensions/canvas/index.ts:86-108` |
| Path-jail idiom | `extensions/canvas/src/documents.ts:79` (`normalizeLogicalPath`), `:107` (`normalizeCanvasDocumentId`), `:180-184` (containment) | copy for widget/data serving & file bindings |
| Atomic file write | `src/infra/replace-file.ts:22` (`replaceFileAtomic`) | temp+rename |
| State dir | `src/config/paths.ts:58` (`resolveStateDir`); plugin-sdk re-export `src/plugin-sdk/state-paths.ts:3` | default `~/.openclaw` |
| Plugin approvals infra | `src/infra/plugin-approvals.ts`; `plugin.approval.requested` scope at `server-broadcast.ts:33` | reuse for custom-widget approval raise |
| Signed asset tickets (template, if needed) | `src/gateway/control-ui.ts:~432-486` (mint+verify, scope+source-bound, timing-safe) | L5 likely doesn't need tickets (auth:"plugin" static route); keep for reference |
| Control UI tab descriptors (SDK) | register: `src/plugins/registry.ts:2198` via `api.session.controls.registerControlUiDescriptor` (facade `src/plugins/types.ts:2581`); type `src/plugins/host-hooks.ts:95` | logbook example: `extensions/logbook/index.ts:98-106` |
| hello projection of tabs | `src/gateway/control-ui-plugin-tabs.ts:61`; wired `src/gateway/server/ws-connection/message-handler.ts:2101-2111` | scope-filtered, per-connection (static until reconnect) |
| Plugin page + bundled views | `ui/src/pages/plugin/plugin-page.ts:27` (`BUNDLED_TAB_VIEWS`), route `ui/src/pages/plugin/route.ts` (single `/plugin` route; tab ref in `?plugin=&id=` query; `loaderDeps` on search) | our view registers as `"dashboard/workspaces"` |
| Sidebar plugin tabs | `ui/src/components/app-sidebar.ts:411-417` | renders hello `controlUiTabs` per group |
| Router | `@openclaw/uirouter` — EXTERNAL npm dep (`ui/package.json`), `definePage`/`createRouter`; route tree `ui/src/app-routes.ts:36-53` | do NOT modify router internals; we add NO new route (plugin page hosts us) |
| Gateway client (UI) | `ui/src/api/gateway.ts` — `GatewayBrowserClient` :490, `GatewayControlUiPluginTab` :176; app wrapper `ui/src/app/gateway.ts:24` (`ApplicationGateway`, `snapshot`) ; context `ui/src/app/context.ts:59-61` | |
| Page data patterns (copy one) | **Subscription/three-way split (preferred):** `ui/src/pages/workboard/workboard-page.ts` (thin LitElement + `@consume(applicationContext)` + ensureSubscriptions) + `ui/src/lib/workboard/index.ts` (controller logic) + `ui/src/pages/workboard/view.ts` (pure render). **Polling:** `ui/src/pages/plugin/logbook-controller.ts:77-78,190-222` | dashboard page = workboard split + event-driven reload (poll fallback) |
| Embed sandbox resolver | `ui/src/lib/chat/tool-display.ts:222` (`resolveEmbedSandbox`); config `ui/src/app/config.ts:42,76,143` (`embedSandboxMode`, default "strict") | custom widgets pin `allow-scripts` regardless; builtin iframe-embed respects config |
| Mocked-gateway E2E harness | `ui/src/test-helpers/control-ui-e2e.ts` | drives a real Vite dev server + fake WS gateway with Playwright |
| i18n pipeline | source `ui/src/i18n/locales/en.ts`; `pnpm ui:i18n:sync` / `ui:i18n:check` (root `package.json`; script `scripts/control-ui-i18n.ts`) | |

## Validation style (the idiom reviewers expect)

Hand-written param readers per method, throwing/responding typed errors — copy `extensions/workboard/src/gateway.ts`:
```ts
function readSlug(params: unknown): string {
  const value = typeof params === "object" && params !== null ? (params as Record<string, unknown>).slug : undefined;
  if (typeof value !== "string" || !/^[a-z0-9-]{1,40}$/.test(value)) {
    throw new Error("invalid tab slug");
  }
  return value;
}
```
Typebox (`Type.Object({...})`) ONLY for agent tool input schemas, mirroring workboard tools.

## Event naming

All dashboard events are `plugin.dashboard.<thing>`; wave 1 uses exactly one: `plugin.dashboard.changed`. Payload minimal (`workspaceVersion`, optional `changedTabSlug`, `actor`) — receivers refetch; do not ship the whole doc in events.

## Test harness cheat-sheet

- Plugin (node): `pnpm vitest run extensions/dashboard` (match workboard's test invocation if it differs — check its package.json/CI).
- UI unit (node/jsdom) + browser (`*.browser.test.ts`, playwright): `ui/` vitest configs — see `ui/package.json` scripts.
- Mocked-gateway E2E: `ui/src/e2e/` + `ui/src/test-helpers/control-ui-e2e.ts` — add dashboard scenarios beside existing ones.
- Type + build + i18n gates: `pnpm tsgo` (or repo typecheck task), `pnpm ui:build`, `pnpm ui:i18n:check`, `oxfmt --check` on touched files (match repo's formatter tasks).

## Commit / PR discipline

- Branch per layer off `feat/modular-dashboard`; PR back into it. Title `feat(dashboard): L<N> <topic>`.
- PR body: what/why, spec link (`docs/plans/modular-dashboard/<file>`), acceptance-checklist copy with checkmarks, verification evidence (test output snippets, screenshots for UI layers).
- If you deviate from the spec: state the deviation + reason in the PR body AND update the spec doc in the same PR. Specs are living documents; silent drift is the failure mode.
