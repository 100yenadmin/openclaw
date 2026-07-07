---
summary: "How to add a builtin dashboard widget renderer or author a sandboxed custom widget"
read_when:
  - Adding a new builtin widget kind to the dashboard plugin
  - Authoring a custom (agent- or user-supplied) dashboard widget
  - Reviewing a PR that adds a `builtin:*` kind or a `custom:*` widget
title: "Dashboard widget authoring"
---

The Dashboard plugin (Control UI "Workspaces") renders widgets in two
different ways. Pick the right one before you start:

| Path               | Runs where                              | Who can add one                                                                          | Data access                                           |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Builtin widget** | Same process as the Control UI (Lit)    | A code change in this repo, reviewed + shipped                                           | Whatever the renderer's TypeScript can read           |
| **Custom widget**  | Sandboxed `<iframe>`, operator-approved | Anyone (an agent tool call or a hand-authored `widget.json` + HTML file), no code review | Only bindings named in `widget.json`, via postMessage |

If you're adding a widget kind that ships with OpenClaw itself (e.g. another
stat/table/chart view), you want a **builtin widget**. If you're letting an
agent or a user drop in a self-contained visualization without touching this
repo, you want a **custom widget**.

## Path 1 — Builtin widgets

A builtin widget is a pure function from `(widget, value)` to a Lit
`TemplateResult`, registered in a lookup table. There is no manifest, no
sandbox, and no approval flow — the code runs trusted, in-process, with full
access to whatever data the renderer chooses to read.

### The contract

```ts
type BuiltinWidgetRenderer = (
  widget: DashboardWidget,
  value: unknown,
  ctx?: BuiltinWidgetContext,
) => TemplateResult;
```

- `widget` — the validated `DashboardWidget` record (id, kind, title, grid,
  `props`, `bindings`). Most renderers only read `widget.title` and
  `widget.props`.
- `value` — the resolved data for the widget's primary binding (already
  fetched over `data:read` / rpc-allowlist machinery upstream — the renderer
  never resolves bindings itself).
- `ctx` — optional context for renderers that need more than the single
  resolved value (rare; most builtins ignore it).

The renderer must be a **pure rendering function**: no direct network calls,
no direct gateway RPC calls, no mutation of `widget`. If a widget needs
several fields from a structured payload, read them off `value` (see
`stat-card`'s `props.metric` pattern below) rather than fetching more data
itself.

### Worked example — `stat-card`

`ui/src/lib/dashboard/widgets/stat-card.ts` renders a big number + label. Read
it end to end before writing a new builtin; it demonstrates every idiom the
other builtins use:

- **`widgetProps(widget)`** — a defensive helper that returns `widget.props`
  narrowed to a record (or `{}`), so a renderer never has to null-check props
  itself.
- **`props.format`** selects presentation (`usd` | `percent` | `int` |
  `raw`), formatted with `Intl.NumberFormat` — copy this pattern instead of
  hand-rolling number formatting.
- **`props.metric`** lets one binding resolve a _structured_ RPC payload
  (e.g. `usage.cost`'s `{ totals: { totalCost, totalTokens } }`) and have the
  stat-card pick one field out of it, so a stat-card can front a rich RPC
  without needing its own binding-pointer syntax. `selectMetric()` is the
  place to add a new named metric.
- **Model/render split** — `mapStatCard()` computes a plain-data
  `StatCardModel` from `(widget, value)`; `renderStatCard()` turns that model
  into `html`. Keeping the mapping function separate and exported makes it
  unit-testable without a DOM (see `stat-card.test.ts` if present, or follow
  the pattern from a sibling builtin's test file).
- **i18n** — user-facing strings (e.g. the "no data yet" placeholder) go
  through `t("dashboard.widget.stat.empty")`, not a hardcoded string.
- **Label dedup** — the renderer drops the inner label when it would just
  repeat `widget.title`, because the widget cell already renders the title in
  its own bar. Small nit, but it is the kind of polish reviewers expect.

### Registering a new builtin — the two-file rule

**This is the step people miss, because the two files live in different
packages and nothing fails locally if you forget one of them.**

1. **`ui/src/lib/dashboard/widgets/index.ts`** — add your render function to
   the `BUILTIN_WIDGET_RENDERERS` map, keyed by the bare kind name (no
   `builtin:` prefix):

   ```ts
   import { renderMyWidget } from "./my-widget.ts";

   export const BUILTIN_WIDGET_RENDERERS: Record<string, BuiltinWidgetRenderer> = {
     "stat-card": (widget, value) => renderStatCard(widget, value),
     // ...
     "my-widget": (widget, value) => renderMyWidget(widget, value),
   };
   ```

2. **`extensions/dashboard/src/schema.ts`** — add the same bare name to the
   `BUILTIN_KIND_PATTERN` regex on the plugin (server) side:

   ```ts
   const BUILTIN_KIND_PATTERN =
     /^builtin:(stat-card|markdown|table|iframe-embed|sessions|usage|cron|instances|activity|my-widget)$/;
   ```

**Why both are required:** `index.ts` controls what the _UI_ can render.
`BUILTIN_KIND_PATTERN` controls what the _workspace document_ is allowed to
say `kind` is — it's the write-time schema gate in
`validateWidget()`/`validateWorkspaceDoc()`. If you only add the renderer, an
agent or user can never actually create a widget with that kind (the RPC that
writes the workspace document rejects it as `<path>.kind is invalid` before it
ever reaches the UI). If you only add the schema entry, the document accepts
the widget but the UI has no renderer for it and the cell falls back to
whatever "unknown builtin kind" handling `dashboard-widget-cell.ts` does
(treat that as a bug report, not a feature).

Grep for the current kind name in both files before you start, and add the
new name to both in the same commit / PR. A quick self-check after editing:

```bash
grep -n 'stat-card' ui/src/lib/dashboard/widgets/index.ts extensions/dashboard/src/schema.ts
```

If your new kind isn't in both lines of output, you're not done.

### Checklist for a new builtin

- [ ] Renderer module under `ui/src/lib/dashboard/widgets/<name>.ts`, pure
      `(widget, value) => TemplateResult`.
- [ ] Model/render split if the widget has any non-trivial data mapping
      (mirrors `mapStatCard`/`renderStatCard`).
- [ ] Entry added to `BUILTIN_WIDGET_RENDERERS` in
      `ui/src/lib/dashboard/widgets/index.ts`.
- [ ] Same bare name added to `BUILTIN_KIND_PATTERN` in
      `extensions/dashboard/src/schema.ts`.
- [ ] User-facing strings go through `t(...)`, not hardcoded.
- [ ] No network/RPC calls inside the renderer — it only reads `value`.

## Path 2 — Custom (sandboxed) widgets

A custom widget is a folder containing a `widget.json` manifest and an HTML
entrypoint (plus any same-folder JS/CSS/image assets it needs). It is served
statically to a fully sandboxed `<iframe>` and talks to the Control UI only
through a versioned `postMessage` bridge. No custom-widget code is trusted:
it cannot reach the network, cannot read anything the operator didn't
explicitly approve, and every capability is gated per-widget.

You do not need write access to this repo to author one. An agent can create
a scaffold with the `dashboard_widget_scaffold` tool (or
`openclaw dashboard scaffold <name>` from the CLI) and then edit the
generated files, or you can hand-write the two files directly under the
plugin's state dir (`<stateDir>/dashboard/widgets/<name>/`).

### The `widget.json` manifest

```json
{
  "schemaVersion": 1,
  "name": "hello-data",
  "title": "Hello Data",
  "entrypoint": "index.html",
  "bindings": [{ "id": "value", "source": "static", "value": "Hello from your dashboard widget." }],
  "capabilities": ["data:read"],
  "preferredSize": { "w": 6, "h": 4 }
}
```

Fields (validated by `extensions/dashboard/src/manifest.ts`
`validateWidgetManifest()` — this is a **security boundary**, not just a
convenience parser; the parent bridge re-checks every child request against
what it loaded here):

- **`name`** — `[A-Za-z0-9._-]{1,64}`, must match the widget's directory
  name. This is the stable identity used for rate-limit/approval state, so
  don't reuse a name for a semantically different widget.
- **`title`** — 1-80 chars, shown as the iframe's `title` attribute and
  widget-cell heading.
- **`entrypoint`** — a logical path (normalized the same way the static
  route normalizes it — no leading `/`, no traversal) to the HTML file to
  serve, almost always `"index.html"`.
- **`bindings`** — an array (max 32) of `{ id, source, ... }` declarations.
  `id` is what the widget's JS passes as `bindingId` in `getData`. Sources:
  - `{ source: "rpc", method: "<allowlisted-method>" }` — resolved by the
    parent against a fixed read-only RPC allowlist (see below). The widget
    never talks to the gateway directly.
  - `{ source: "file", path: "<logical-path>", pointer?: "<json-pointer>" }`
    — resolved against the plugin's own jailed data dir; `pointer` optionally
    extracts one field.
  - `{ source: "static", value: <any JSON> }` — a value baked into the
    manifest itself (useful for the scaffold default and for widgets that
    need no live data at all).
- **`capabilities`** — subset of `["data:read", "prompt:send"]`.
  - `data:read` is declarative today, not enforced at resolve time: the
    bridge's `getData` handler (`handleGetData` in
    `ui/src/lib/dashboard/bridge.ts`) gates purely on whether the requested
    `bindingId` is declared in `manifest.bindings`, and never checks
    `capabilities` at all. Declare it anyway — it documents intent to
    reviewers and may become an enforced gate later — but don't rely on
    omitting it as a way to prevent binding reads; the only real gate is
    "is this binding declared in the manifest."
  - `prompt:send` gates `sendPrompt` (see below) — without it, every
    `dashboard:sendPrompt` message is denied with `capability_denied` before
    any confirm dialog is shown.
  - **There is no `state:persist` capability today.** If your widget needs to
    remember something across reloads, the only currently-implemented
    options are a `file`-source binding your own tooling writes, or in-memory
    state that resets when the iframe remounts (layout drag, tab switch,
    widget re-add all recreate the iframe). Treat `state:persist` /
    `getState` / `setState` as **not yet implemented** — do not build a
    widget that assumes they exist. If you need durable per-widget state,
    say so in your PR/issue rather than inventing a bridge message the
    parent doesn't handle; it will silently do nothing (the well-formedness
    filter in `bridge.ts` drops any `type` outside the four it knows).
- **`preferredSize`** — optional `{ w, h }` grid-cell hint (columns 1-12,
  rows 1-20) used when the widget is first added to a tab.

### The postMessage bridge

Every message is `{ v: 1, type: "...", ...fields }`. `v` must be `1`
(`BRIDGE_ENVELOPE_VERSION`); anything else, or an unknown `type`, is dropped
silently by the parent (counted internally, never surfaced to the child).

**Child → parent** (what your widget's JS sends):

| Type                   | Fields                   | What happens                                                                                                                                                                                 |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard:ready`      | —                        | Acknowledged only; send this once on load.                                                                                                                                                   |
| `dashboard:getData`    | `requestId`, `bindingId` | Parent resolves the named binding (must be declared in the manifest) and replies with `dashboard:data` or `dashboard:error`. 10s timeout by default.                                         |
| `dashboard:getTheme`   | `requestId`              | Parent replies `dashboard:theme` with current CSS custom-property values.                                                                                                                    |
| `dashboard:sendPrompt` | `requestId`, `text`      | Requires the `prompt:send` capability, an operator confirm dialog quoting the exact text, and a rate limit (1 in-flight + 10/min, keyed by widget name so a remount can't reset the budget). |

**Parent → child** (what your widget's `message` listener receives):

| Type              | Fields                                          | When                                                                                                |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dashboard:data`  | `requestId`, `bindingId`, `data`                | Reply to `getData`.                                                                                 |
| `dashboard:push`  | `bindingId`, `data`                             | Unsolicited refresh of a binding you already have (broadcast-driven — re-render, don't re-request). |
| `dashboard:theme` | `requestId`, `tokens` (`Record<string,string>`) | Reply to `getTheme`. Apply the tokens you care about as CSS custom properties.                      |
| `dashboard:error` | `requestId?`, `code`, `message`                 | See error codes below.                                                                              |

Error `code` values: `binding_denied` (undeclared binding, or an `rpc`
binding whose method isn't allowlisted), `capability_denied` (missing
`prompt:send`), `rate_limited`, `prompt_declined` (operator said no — nothing
is sent), `timeout`, `resolve_failed`, `malformed`.

Minimal listener skeleton (see the starter templates for full working
examples):

```js
function post(type, payload = {}) {
  window.parent.postMessage({ v: 1, type, ...payload }, "*");
}
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.v !== 1) return;
  if (msg.type === "dashboard:data" || msg.type === "dashboard:push") {
    render(msg.data);
  }
});
post("dashboard:ready");
```

Note the target origin is always `"*"` on both sides — the iframe's origin
is opaque (`null`, because of the sandbox attribute), so origin-string
comparison is structurally impossible. Don't try to "tighten" this to a real
origin; there isn't one. The security boundary is the sandbox + CSP, not
origin checking.

### Operator approval flow

A widget an agent scaffolds enters `workspace.widgetsRegistry` with
`status: "pending"`. Only an `approved` entry gets an actual `<iframe>` — a
pending or rejected widget's cell shows a state prompting the operator to
review it instead of executing any of its code. This is the human-in-the-loop
gate for arbitrary HTML/JS running in the Control UI: nothing a custom widget
ships is trusted until an operator explicitly flips it to `approved`.

Treat "pending" as "untrusted, not yet reviewed" all the way through your
own tooling — don't build any flow that auto-approves, and don't assume a
scaffolded widget is live until you've checked the registry entry.

### Sandbox and CSP constraints

The iframe and its response headers are the actual security boundary, not
convention. From the host (`ui/src/components/dashboard-custom-widget.ts`)
and the static server (`extensions/dashboard/src/serve.ts`):

- **`sandbox="allow-scripts"`** — a hardcoded constant, never templated.
  Notably absent: `allow-same-origin` (keeps the origin opaque),
  `allow-forms`, `allow-popups`, `allow-top-navigation`. Your widget cannot
  navigate the top frame, open popups, or submit forms out of the sandbox.
- **`referrerpolicy="no-referrer"`** — the frame leaks no referrer to
  whatever it might (not) reach.
- **Content-Security-Policy** on every served widget response:

  ```
  default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'
  ```

  `connect-src 'none'` is the load-bearing line: it makes "this widget cannot
  make a network request" a property enforced by the browser, not just a
  guideline. `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` — all of
  them are blocked from inside the widget, unconditionally. **Never build a
  widget that expects to fetch anything itself.** All data comes in through
  `dashboard:data` / `dashboard:push` after you ask for a declared binding.
  `frame-ancestors 'self'` means the widget can only be embedded by the
  Control UI itself, not iframed elsewhere.

- **Served file types are allowlisted by extension**: `.html`, `.js`,
  `.css`, `.json`, `.svg`, `.png`, `.jpg`/`.jpeg`, `.webp`, plus a couple of
  font types. Anything else 404s. In practice this means: **no ES modules
  via bundler output that expects `.mjs`, no source maps, no WASM** — write
  your widget as a single classic `<script>` (or a same-allowlisted `.js`
  file) that runs standalone in the browser with zero build step.
- **Every rejection from the static route is a 404, never 403** — the route
  is deliberately non-revealing about whether a widget or file exists, so
  don't rely on distinguishing "doesn't exist" from "not allowed" from the
  HTTP status alone.

### Checklist for a new custom widget

- [ ] `widget.json` validates against the schema above (run it through
      `dashboard_widget_scaffold`/CLI scaffold first if unsure, then edit).
- [ ] Every `bindingId` your JS requests via `getData` is declared in
      `bindings` with a matching `id`.
- [ ] Declares `capabilities: ["prompt:send"]` if (and only if) it calls
      `sendPrompt` — otherwise expect `capability_denied`.
- [ ] Sends `dashboard:ready` once on load; re-renders on both
      `dashboard:data` and `dashboard:push`.
- [ ] Makes **zero** direct network calls (there is no network path open to
      it — `connect-src 'none'` blocks it structurally either way).
- [ ] No assumption of `getState`/`setState`/`state:persist` — not
      implemented yet.
- [ ] Entrypoint + assets only use allowlisted extensions (see above); no
      build step, no ES module imports across files.
- [ ] Handles `dashboard:error` gracefully (at minimum, don't throw
      uncaught on an unexpected `code`).

## See also

- `ui/src/lib/dashboard/widgets/index.ts` — builtin renderer registry.
- `ui/src/lib/dashboard/widgets/stat-card.ts` — worked builtin example.
- `extensions/dashboard/src/schema.ts` — write-time workspace/widget schema
  (`BUILTIN_KIND_PATTERN`, binding validation, size limits).
- `extensions/dashboard/src/manifest.ts` — `widget.json` schema and
  validation.
- `ui/src/lib/dashboard/bridge.ts` — the parent-side bridge implementation
  (DOM-free, unit-tested).
- `ui/src/components/dashboard-custom-widget.ts` — the sandboxed iframe host
  that wires the bridge to a real `<iframe>`.
- `extensions/dashboard/examples/widgets/` — starter templates
  (`hello-data`, `notes`, `calculator`) demonstrating the bridge protocol
  end to end.
