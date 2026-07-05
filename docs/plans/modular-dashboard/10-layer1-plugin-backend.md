# L1 — dashboard plugin backend (`extensions/dashboard/`)

**Goal:** the workspace document + validated mutation store + `dashboard.*` gateway methods + change broadcasts + default workspace seed. Pure plugin; ZERO core changes. Fully testable headless.

**Read first:** `00-vision-and-architecture.md` §1–4, `01-conventions.md`. **Templates to imitate:** `extensions/workboard/` (plugin shape, shared-store seam, gateway method idiom), `extensions/logbook/` (newest plugin, manifest shape), `extensions/canvas/src/documents.ts` (path-jail style — used in L5 but the store's file-binding jail shares the idiom).

## Files to create

```
extensions/dashboard/
  openclaw.plugin.json      # id "dashboard", enabledByDefault:true, activation.onStartup:true
  package.json              # match logbook/workboard's shape (name @openclaw/dashboard-plugin)
  index.ts                  # register(api): construct ONE DashboardStore; wire gateway methods,
                            #   tools (L2), CLI (L2), http route (L5), Control UI descriptor (L3)
  src/store.ts              # DashboardStore
  src/store.test.ts
  src/schema.ts             # WorkspaceDoc types + validate/normalize + migrations
  src/schema.test.ts
  src/gateway.ts            # registerDashboardGatewayMethods({ api, store })
  src/gateway.test.ts
  src/default-workspace.ts  # seed doc (createdBy:"system") — content per L4 spec §default
  src/data-read.ts          # binding resolver behind dashboard.data.read (rpc allowlist + file jail)
  src/data-read.test.ts
```

## DashboardStore (`src/store.ts`)

- Doc path: `path.join(resolveStateDir(env), "dashboard", "workspace.json")` — import `resolveStateDir` from the plugin SDK state-paths re-export (workboard does this; copy its import).
- `read()`: load + parse; if absent → seed from `default-workspace.ts` and persist; run `migrate(doc)` if `schemaVersion` < current; throw on future versions.
- `mutate(fn, { actor })`: acquire in-process async mutex → `structuredClone` current doc → `fn(draft)` → `validateWorkspaceDoc(draft)` → serialized-size check (≤ 256 KB) → push undo snapshot → `replaceFileAtomic` write → bump `workspaceVersion` (monotonic int, stored in doc) → return `{ doc, changed }`. Reject = throw; NO partial writes.
- Undo: write previous serialization to `<stateDir>/dashboard/undo/<NNNN>.json`, ring of 20 (delete oldest). `undo()` = restore newest snapshot via the same validate+write path (undo of undo = redo not required in v1).
- Concurrency note: single gateway process is the sole writer; the mutex serializes tool/RPC/CLI callers within it. Document this invariant in a comment.

## Schema + validation (`src/schema.ts`)

Hand-written guards (repo idiom — see `01-conventions.md §validation`; NO zod). Export `validateWorkspaceDoc(value: unknown): WorkspaceDoc` throwing on first violation with a precise message. Validate:

- `schemaVersion === 1` (after migrations).
- `tabs`: array ≤ 32; each: `slug` matches `^[a-z0-9-]{1,40}$`, unique; `title` 1–80 chars; `icon` optional string ≤ 40; `hidden` boolean; `createdBy` matches `^(user|system|agent:[A-Za-z0-9._-]{1,64})$`.
- `widgets` per tab ≤ 24; each: `id` `^[A-Za-z0-9_-]{1,48}$` unique in doc; `kind` `^builtin:(stat-card|markdown|table|iframe-embed|sessions|usage|cron|instances|activity)$` OR `^custom:[A-Za-z0-9._-]{1,64}$`; `grid` ints `x∈[0,11], y∈[0,499], w∈[1,12], h∈[1,20]`, `x+w ≤ 12`; `collapsed`/`hidden` booleans; `title` ≤ 80.
- `bindings`: record of bindingId → discriminated union:
  - `{ source:"rpc", method }` — method must be in `DATA_READ_RPC_ALLOWLIST` (exported const, see data-read).
  - `{ source:"file", path, pointer? }` — `path` is RELATIVE, no `..`/absolute/`:`/control chars (reuse the logical-path normalization idiom from canvas documents), resolves under `<stateDir>/dashboard/data/`.
  - `{ source:"static", value }` — JSON value ≤ 8 KB serialized.
- `widgetsRegistry`: name → `{ status: "pending"|"approved"|"rejected", createdBy, approvedBy?, approvedAt? }`.
- `prefs.tabOrder`: slugs subset.

## Gateway methods (`src/gateway.ts`)

`registerDashboardGatewayMethods({ api, store })` — register via `api.registerGatewayMethod(name, handler, { scope })` exactly like `extensions/workboard/src/gateway.ts` (copy its `respondError` + param-reader helper style):

| Method | Scope | Params → behavior |
|---|---|---|
| `dashboard.workspace.get` | read | `{}` → full doc + `workspaceVersion` |
| `dashboard.tab.create` | write | `{ slug?, title, icon?, actor? }` (slug generated from title if absent) |
| `dashboard.tab.update` | write | `{ slug, patch:{title?,icon?,hidden?} }` |
| `dashboard.tab.delete` | write | `{ slug }` |
| `dashboard.tab.reorder` | write | `{ order: string[] }` |
| `dashboard.widget.add` | write | `{ tab, widget }` (id generated if absent) |
| `dashboard.widget.update` | write | `{ tab, id, patch }` (kind immutable) |
| `dashboard.widget.move` | write | `{ tab, id, grid }` or `{ id, toTab }` |
| `dashboard.widget.remove` | write | `{ tab, id }` |
| `dashboard.widget.setLayout` | write | `{ tab, layout:[{id,grid}] }` batch |
| `dashboard.widget.approve` | write | `{ name, decision:"approved"\|"rejected" }` |
| `dashboard.workspace.replace` | write | `{ doc }` full-document set (agent bulk authoring) |
| `dashboard.workspace.undo` | write | `{}` |
| `dashboard.data.read` | read | `{ binding }` → resolved data (see data-read) |

- `actor` param: optional; DEFAULT provenance for RPC/CLI callers is `"user"`. (Agent tools pass `agent:<id>` — L2.)
- Every successful WRITE ends with `opts.context.broadcast("plugin.dashboard.changed", { workspaceVersion, changedTabSlug, actor })`. Reads never broadcast. (The handler receives the request context exposing `broadcast` — see conventions §broadcast.)

## Binding resolver (`src/data-read.ts`)

> **AMENDED 2026-07-06 (blocker found in execution — see issue #3):** plugin gateway-method handlers
> cannot in-process-dispatch other gateway methods at this HEAD (`dispatchGatewayMethod` in
> `src/plugin-sdk/gateway-method-runtime.ts` is gated to authenticated plugin HTTP routes via
> `gatewayMethodDispatchAllowed`). Therefore **`rpc` bindings are resolved CLIENT-SIDE by the trusted
> Control UI** (which holds operator scopes over its own authenticated socket — same authz boundary),
> and `dashboard.data.read` serves `file`/`static` only. The `DATA_READ_RPC_ALLOWLIST` remains
> plugin-side as a WRITE-TIME schema constraint (which methods a binding may name).

`resolveBinding(binding, { context })`:
- `rpc`: NOT resolved server-side. `dashboard.data.read` responds with typed
  `{ code: "binding_client_resolved" }` so callers know to resolve via their own gateway client.
  Schema validation (write time) still enforces method ∈ `DATA_READ_RPC_ALLOWLIST` (exported, tested).
- `file`: normalize + jail under `<stateDir>/dashboard/data/`; ≤ 1 MB; parse JSON (or return raw text for `.md`/`.csv`); apply optional RFC-6901 `pointer` for JSON.
- `static`: echo value.
- Errors → typed `{ code: "binding_denied"|"binding_not_found"|"binding_too_large"|"binding_invalid"|"binding_client_resolved", message }`.

## Acceptance criteria

- [ ] Plugin loads with the gateway (enabledByDefault) with zero core-file diffs (`git diff --stat` shows only `extensions/dashboard/`).
- [ ] All 14 methods registered with the scopes above; unknown params / bad shapes rejected with clear errors.
- [ ] `workspace.json` created on first read with the default workspace; atomic write verified (temp+rename — inspect implementation uses `replaceFileAtomic`).
- [ ] Undo ring: 21st mutation evicts the oldest; undo restores exactly the previous doc.
- [ ] Size cap: an oversized `workspace.replace` is rejected; doc on disk unchanged.
- [ ] Mutex: two concurrent `mutate` calls serialize (test with artificial delay).
- [ ] Broadcast fired once per successful write with correct payload; NOT fired on reads or failed writes.
- [ ] `dashboard.data.read`: rpc bindings → `binding_client_resolved` (never proxied); file traversal (`../`, absolute) → `binding_invalid`; happy paths for file/static; write-time schema rejects non-allowlisted rpc method names.
- [ ] Every schema reject path has a test (slug charset, dup slug, grid overflow, kind pattern, binding union, caps, createdBy pattern).

## Verification commands

```
pnpm vitest run extensions/dashboard            # or repo's per-package test invocation — see 01-conventions §tests
pnpm tsgo                                        # typecheck task per repo scripts
```
(Local runs OK on this machine class if repo is under /Volumes/LEXAR; otherwise push and use fork CI.)

## Out of scope for L1

CLI, agent tools (L2). Control UI descriptor + any ui/ change (L3). Builtin widget rendering (L4). HTTP widget serving, manifest handling beyond registry status, approval UI (L5). Est. size: ~1,400–1,900 LOC incl. tests.
