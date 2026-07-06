# L5 — Custom widget host (sandboxed agent-authored widgets)

**Goal:** the novel capability — agents author HTML widgets that render inside operator dashboards, safely. Serving, manifest, sandboxed iframe host, postMessage bridge, approval flow. **Highest security surface in the project — implement exactly as specified; deviations require a security note in the PR and a spec update.**

**Depends on:** L1 (registry/store), L3 (cell dispatch), L2 (`widget-scaffold` exists). **Read:** `00 §2, §6` (normative), `01-conventions` (path-jail, route auth, approvals).

## Server side (plugin)

```
extensions/dashboard/src/http-route.ts   # registerHttpRoute({ path: "/plugins/dashboard/widgets", auth: "plugin", ... })
extensions/dashboard/src/serve.ts        # static file resolution + jail + headers
extensions/dashboard/src/serve.test.ts
extensions/dashboard/src/manifest.ts     # widget.json load/validate (schema per 00 §2)
extensions/dashboard/src/manifest.test.ts
```

- Route: prefix-match under the plugin HTTP router (canvas `index.ts:86-108` registration shape). `auth:"plugin"` — this is DELIBERATE (sandboxed frames carry no device token) and is safe ONLY because the route is static-file-only. The handler must never read query-selected state, never expose data, never accept non-GET.
- Resolution: `/plugins/dashboard/widgets/<name>/<path...>` → name via the canvas charset check (`^[A-Za-z0-9._-]+$` idiom), `<path...>` via logical-path normalization, then containment check against `<stateDir>/dashboard/widgets/<name>/` (copy `extensions/canvas/src/documents.ts:79,107,180-184` verbatim in idiom). Violations → 404 (not 403 — don't leak existence).
- Headers on every response: `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'` (widgets are self-contained; `connect-src 'none'` is the backstop making "no network" structural, not just conventional); `X-Content-Type-Options: nosniff`; correct `Content-Type` by extension (allowlist: html/js/css/json/svg/png/jpg/webp/woff2/txt/md/csv); everything else → 404.
- **Serving gate:** only widgets whose registry `status === "approved"` are served AT ALL (pending/rejected → 404). Belt-and-braces with the UI's render gate.

## UI side

```
ui/src/components/dashboard-custom-widget.ts        # iframe host + bridge (parent side)
ui/src/components/dashboard-custom-widget.test.ts
ui/src/lib/dashboard/bridge.ts                       # protocol types + parent handler (unit-testable, no DOM)
ui/src/lib/dashboard/bridge.test.ts
```

- Iframe: `<iframe sandbox="allow-scripts" src="<basePath>/plugins/dashboard/widgets/<name>/index.html" referrerpolicy="no-referrer">`. NEVER add `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, or any other token — the attribute is a constant, not config.
- **Bridge (normative protocol, envelope `{ v:1, type, ... }`):**
  - child→parent: `dashboard:ready`, `dashboard:getData { requestId, bindingId }`, `dashboard:getTheme { requestId }`, `dashboard:sendPrompt { requestId, text }`
  - parent→child: `dashboard:data { requestId, bindingId, data }`, `dashboard:push { bindingId, data }`, `dashboard:theme { requestId, tokens }`, `dashboard:error { requestId, code, message }`
  - Parent accept filter: `event.source === iframe.contentWindow` (identity — sandboxed origin serializes as `null`, so never compare origin strings) AND known `type` AND well-formed payload; else drop silently (count drops in a debug counter for tests).
  - Parent → child posts use `targetOrigin "*"` (opaque-origin constraint) — acceptable because payloads are only binding data/theme tokens the widget is entitled to; NEVER post anything else (no config, no session data, no URLs with tokens).
  - `getData`/`push`: parent resolves ONLY bindings declared in the widget's manifest (by `bindingId`) — a widget cannot request arbitrary bindings. Resolution: `file`/`static` via `dashboard.data.read` (server re-validates the jail); `rpc` by the parent calling the manifest-named read method directly on its gateway client (method must be in the plugin's write-time allowlist — parent re-checks against the manifest before calling; amended 2026-07-06, issue #3).
  - `sendPrompt`: requires manifest capability `prompt:send`; parent shows a confirm dialog quoting the exact text; only on operator confirm is the prompt dispatched via the existing chat-send path; rate-limit 1 in-flight + 10/minute per widget.
  - `getTheme`: returns the CSS custom-property token values currently applied (read from computed styles of the document root; cache per theme change).
  - Timeouts: parent answers `getData` within 10s or posts `dashboard:error {code:"timeout"}`.
- **Pending/rejected states:** L3's placeholder card gains Approve/Reject buttons (operator-only) → `dashboard.widget.approve` (handler lives in L1 `gateway.ts`, scope `operator.write`, validates `approved`/`rejected`). Only `status:"approved"` widgets ever get an iframe (server 404s assets for pending/rejected too — double gate).
  > **AMENDED 2026-07-06 (L5 execution):** the extra `pluginApprovalManager` notification raise (so the request also surfaces in the standard approvals UI) is **DEFERRED**. At this HEAD the plugin-approvals broker (`plugin.approval.requested` lifecycle) is NOT exposed as an `api.*` hook to a bundled extension; emitting a raw broadcast would bypass the broker's resolve/timeout lifecycle and risk orphaned approval requests — a net security negative. The operator-gated placeholder Approve/Reject → `dashboard.widget.approve` IS the acceptance gate and is fully implemented. Re-wiring the standard-surface notification requires a small core PR exposing the broker to extensions (future, out of wave 1).

## Scaffold template (ships in L2, finalized here)

`index.html` template must demonstrate: envelope v1 handshake, `getData` + `onData`(=`dashboard:push`) usage, theme tokens applied to CSS vars, zero external requests, and a visible "built by <createdBy>" footer convention. Keep < 100 lines, framework-free (agents can bring their own inside the sandbox).

## Acceptance criteria (security list is the review gate)

- [ ] Path-jail suite: `../`, encoded `%2e%2e`, absolute, backslash, symlink-out, name-charset violations, non-GET, disallowed extension → ALL 404; only own-dir files served with correct headers (assert CSP + nosniff on every response).
- [ ] Pending/rejected widgets: server 404s assets AND UI never constructs the iframe.
- [ ] Bridge: handshake works; foreign-window postMessage ignored (test with a second iframe); unknown types dropped; undeclared `bindingId` → `dashboard:error {code:"binding_denied"}`; `sendPrompt` without capability → denied without dialog; with capability → dialog, deny path sends nothing, confirm path sends exactly once; rate-limit test.
- [ ] `connect-src 'none'`: E2E asserts a widget `fetch()` to any URL rejects.
- [ ] Sandbox attribute is exactly `allow-scripts` (DOM assertion in E2E).
- [ ] Kill test from demo script row 10 (throwing widget → isolated error card) passes.
- [ ] Scaffolded template renders and round-trips `getData` in the E2E harness (fixture widget).

## Verification

```
pnpm vitest run extensions/dashboard        # serve/manifest/jail suites
cd ui && pnpm test                          # bridge unit + component tests
# E2E: custom-widget scenario (approve flow, bridge, kill test) via control-ui-e2e harness
pnpm ui:build && pnpm ui:i18n:check
```

Then run `90-demo-script.md` end-to-end and attach evidence to the integration-branch PR.

## Out of scope

`command:` bindings, widget marketplace/gallery, cross-widget messaging, widget-initiated RPC beyond declared bindings, A2UI widget kind. Est. ~1,200–1,600 LOC incl. tests.
