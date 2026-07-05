# L3 — Workspaces bundled tab view (the only core `ui/` changes)

**Goal:** the Workspaces surface in the Control UI: plugin-declared sidebar tab → bundled native view → live workspace tab strip → widget grid with drag/drop, collapse/hide, per-cell error boundaries — rendered from `workspace.json`, live-updating on `plugin.dashboard.changed`.

**Depends on:** L1 (RPCs+events). **Read:** `00 §5`, `01-conventions` (plugin-page seam, page data patterns, i18n, lean-deps). **Template to follow precisely:** how #99930 landed logbook — descriptor + `BUNDLED_TAB_VIEWS` entry + page files — but with workboard's three-way split (`page`/`lib`/`view`) because our controller is stateful.

## Plugin-side (1 line-ish, in `extensions/dashboard/index.ts`)

```ts
api.session.controls.registerControlUiDescriptor({
  surface: "tab",
  id: "workspaces",
  label: "Workspaces",
  description: "Composable dashboards you and your agents build together.",
  icon: "layout",          // pick an existing icon name; unknown falls back generic
  group: "control",
  order: -10,               // near top of control group
  requiredScopes: ["operator.read"],
});
```
No `path` — we ship a bundled view, so the descriptor-path iframe branch never triggers for us.

## Core `ui/` changes

### 1. Register the bundled view (`ui/src/pages/plugin/plugin-page.ts`)

Add one entry to `BUNDLED_TAB_VIEWS`:
```ts
"dashboard/workspaces": async () => {
  const [view, controller] = await Promise.all([
    import("./dashboard-view.ts"),
    import("./dashboard-controller.ts"),
  ]);
  return { render: view.renderDashboard, stop: controller.stopDashboard };
},
```
(Match the logbook entry's lazy-import shape exactly; keep alphabetical/nearby placement.)

### 2. New files

```
ui/src/pages/plugin/dashboard-view.ts        # pure render fns (workboard view.ts style)
ui/src/pages/plugin/dashboard-view.test.ts
ui/src/pages/plugin/dashboard-controller.ts  # thin lifecycle glue: start/stop, delegates to lib
ui/src/pages/plugin/dashboard-controller.test.ts
ui/src/lib/dashboard/index.ts                # controller/data logic (workboard lib split)
ui/src/lib/dashboard/index.test.ts
ui/src/lib/dashboard/grid.ts                 # grid math + hand-rolled pointer drag/drop + resize
ui/src/lib/dashboard/grid.test.ts
ui/src/lib/dashboard/types.ts                # WorkspaceDoc UI types (mirror plugin schema; keep in sync note)
ui/src/components/dashboard-widget-cell.ts   # cell chrome: title bar, collapse, menu, error boundary
ui/src/components/dashboard-widget-cell.test.ts
ui/src/styles/… or co-located CSS per current styles conventions (check how workboard/logbook CSS is organized post-refactor and match)
```

### 3. Behavior spec

- **Load:** on first render, `lib/dashboard.loadWorkspace(client)` → `dashboard.workspace.get`. Loading/blank/error states per existing card patterns (`lazy-view-state` style seen in plugin-page).
- **Live updates:** subscribe to gateway events for `plugin.dashboard.changed` → refetch (compare `workspaceVersion`, skip if stale/own-echo). Discover the concrete event-subscription surface on `GatewayBrowserClient`/`ApplicationGateway` at build time (`ui/src/api/gateway.ts`, `ui/src/app/gateway.ts`); if plugin events are not surfaced to page code, fall back to logbook-style polling at 5s AND file an integration note in the PR — but prefer the push path; the WS client demonstrably receives event frames.
- **Tab strip:** across the top inside the view (workspace tabs from doc, honoring `prefs.tabOrder`, hidden tabs in an overflow "hidden" menu). Active tab in the `/plugin` route query (`?plugin=dashboard&id=workspaces&ws=<slug>`) so deep links + back/forward work — the plugin route already `loaderDeps` on `location.search`; read via the same mechanism the plugin page uses for `plugin`/`id` (extend `pluginTabRefFromSearch` usage locally — do NOT modify the shared route file unless trivially additive).
- **Grid:** CSS grid, 12 columns, row height fixed (e.g. 56px + gap). Widgets absolutely placed by `grid-column/row` spans from doc coords.
- **Drag/drop + resize (hand-rolled, `lib/dashboard/grid.ts`):** pointer-events on the cell title bar (move) and corner handle (resize); ghost preview snapped to grid; on drop → optimistic local update + `dashboard.widget.move`/`setLayout`; on RPC failure → revert + toast (match repo's notification pattern if one exists, else inline error). Keyboard fallback: cell menu offers move/resize increments (a11y note in PR).
- **Cell chrome (`dashboard-widget-cell.ts`):** title, collapse toggle (persists via `dashboard.widget.update`), kebab menu (hide, remove, move-to-tab, edit-title), provenance badge when `createdBy` is an agent (small "AI" chip with agent id tooltip — this is a *feature*: operators see what the agent built).
- **Error boundary per cell:** widget render wrapped; a throw renders an error card (widget title + short message + "remove" affordance) — the shell and sibling widgets are unaffected (E2E-tested).
- **Widget dispatch:** `kind` startsWith `builtin:` → registry lookup in `lib/dashboard` (L4 fills it; L3 ships `markdown` + `stat-card` minimal versions so the layer is demoable); `custom:` → placeholder card in L3 (L5 replaces with the iframe host).
- **Empty states:** no tabs → onboarding card ("Ask your agent to build a dashboard, or `openclaw dashboard tabs create …`"); empty tab → add-widget hint card.

### 4. i18n + CSS

All strings via `t("dashboard.…")` keys added to `ui/src/i18n/locales/en.ts`; run `pnpm ui:i18n:sync`; regenerated bundles in an ISOLATED commit. CSS follows the post-refactor convention (verify where workboard/logbook styles live and match — do not invent a new styles location).

## Acceptance criteria

- [ ] Sidebar shows Workspaces (descriptor advertised; hidden for connections lacking `operator.read`).
- [ ] `?plugin=dashboard&id=workspaces&ws=<slug>` deep-links to the right tab; back/forward works.
- [ ] Default workspace renders from a mocked `dashboard.workspace.get`; mocked `plugin.dashboard.changed` triggers refetch + re-render (or 5s poll fallback, if push proved unavailable — PR must state which shipped).
- [ ] Drag, resize, collapse, hide each persist through the RPC and survive reload; optimistic update reverts on mocked RPC failure.
- [ ] Broken widget render → error card in that cell only (E2E asserts siblings still render).
- [ ] Provenance chip renders for `createdBy: agent:*` widgets.
- [ ] `pnpm ui:i18n:check` clean; `pnpm ui:build` clean; no new `ui/` npm deps; core diff limited to: `plugin-page.ts` (one registry entry), new files listed above, i18n source+regenerated bundles, CSS per convention.
- [ ] Unit: grid math (snap, collision policy — overlapping allowed? NO: reject drops that overlap, offer nearest free slot), search/route helpers. Browser tests for cell chrome. E2E: scenario file beside existing ones using `control-ui-e2e.ts` harness.

## Verification

```
cd ui && pnpm test                 # or repo's ui unit/browser invocations per package.json
pnpm ui:i18n:check && pnpm ui:build
# E2E: run the dashboard scenario via the mocked-gateway harness
```

## Out of scope

Real data widgets beyond markdown/stat-card (L4), custom-widget iframe host + approval UI (L5), per-workspace sidebar entries (future core PR — documented in 00 §5). Est. ~1,300–1,700 LOC incl. tests. **This layer defines the product's feel — screenshots (light+dark, post-#99289 themes) required in the PR.**
