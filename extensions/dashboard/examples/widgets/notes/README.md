# notes

A scratchpad widget — and a deliberately honest example of the current
persistence gap.

**There is no `getState`/`setState` bridge message and no `state:persist`
capability in this codebase yet.** This widget keeps note text in its own
in-memory JS state (survives re-renders, resets on iframe remount — dragging
the widget, switching tabs away and back, or removing/re-adding it all
recreate the iframe). It does not attempt to call a `setState`-shaped message
because the parent bridge (`ui/src/lib/dashboard/bridge.ts`) only recognizes
four inbound message types (`ready`, `getData`, `getTheme`, `sendPrompt`) —
anything else is silently dropped by its well-formedness filter, so a
widget that "persists" by posting an unrecognized message type would just
look like it works while doing nothing.

If you need real cross-reload persistence for a custom widget, that's a
capability gap in the current SDK — worth raising as a follow-up rather than
routing around it from inside a widget. See the note at the top of
`index.html` and `docs/plugins/dashboard-widget-authoring.md`'s manifest
section for the full picture.

This template also demonstrates `dashboard:getTheme` (applying theme tokens
as CSS custom properties) since `hello-data` doesn't cover that message.
