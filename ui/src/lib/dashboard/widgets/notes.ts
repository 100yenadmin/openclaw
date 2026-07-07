// builtin:notes — an editable notes/todo pad persisted via the write-back state
// store. Builtins render in the TRUSTED control UI (not the sandboxed iframe), so
// this reaches the gateway state RPCs directly through `ctx.state` — the host
// binds those RPCs to THIS widget's id, so the renderer never names an id.
//
// Renderers are stateless: interactivity lives in the DOM via a `ref()` callback
// that hydrates the textarea from `ctx.state.get()` on mount and wires a debounced
// `ctx.state.set()` on input. Without `ctx.state` (no gateway client) the pad
// degrades to read-only with a hint.

import { html, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../../i18n/index.ts";
import type { DashboardWidget } from "../types.ts";
import type { BuiltinWidgetContext, BuiltinWidgetState } from "./types.ts";
import { widgetProps } from "./types.ts";

/** Debounce window before an edit is persisted (ms). */
export const NOTES_PERSIST_DEBOUNCE_MS = 500;

/** Coerce a persisted state blob to the editable text. Stored blob is the raw string. */
export function notesTextFromState(state: unknown): string {
  if (typeof state === "string") {
    return state;
  }
  return "";
}

/** Seed text from `props` when there is no persisted state yet (author-provided default). */
function notesSeedText(widget: DashboardWidget): string {
  const props = widgetProps(widget);
  if (typeof props.text === "string") {
    return props.text;
  }
  return "";
}

/**
 * Callback ref that hydrates the textarea from the widget's persisted state, then
 * wires debounced persistence on input. The `ref` directive calls this with the
 * element on connect (and `undefined` on disconnect). All state errors are
 * swallowed: a failed load/save leaves the pad usable rather than throwing into
 * the cell's error boundary.
 */
function bindNotesEditor(state: BuiltinWidgetState): (element: Element | undefined) => void {
  return (element) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      return;
    }
    const textarea = element;
    // Guard against a double-bind (Lit may call the ref again on re-render).
    if (textarea.dataset.notesBound === "1") {
      return;
    }
    textarea.dataset.notesBound = "1";

    void state
      .get()
      .then((result) => {
        // Only hydrate if the user hasn't started typing before the load resolved.
        if (textarea.dataset.notesDirty !== "1") {
          textarea.value = notesTextFromState(result.state);
        }
      })
      .catch(() => {
        // A failed hydrate keeps the seed/empty value — the pad stays editable.
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    textarea.addEventListener("input", () => {
      textarea.dataset.notesDirty = "1";
      const next = textarea.value;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void state.set(next).catch(() => {
          // A failed save is non-fatal; the next edit retries.
        });
      }, NOTES_PERSIST_DEBOUNCE_MS);
    });
  };
}

export function renderNotes(
  widget: DashboardWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const placeholder = t("dashboard.widget.notes.placeholder");
  if (!ctx.state) {
    // No gateway client → no persistence. Degrade to a read-only view of any
    // author-seeded text with a hint, rather than an editable pad that silently
    // drops every edit.
    const seed = notesSeedText(widget);
    return html`
      <div class="dashboard-notes dashboard-notes--readonly" data-test-id="dashboard-notes">
        <textarea
          class="dashboard-notes__pad"
          data-test-id="dashboard-notes-pad"
          readonly
          aria-label=${widget.title}
          placeholder=${placeholder}
        >
${seed}</textarea
        >
        <div class="dashboard-notes__hint" data-test-id="dashboard-notes-hint">
          ${t("dashboard.widget.notes.readonlyHint")}
        </div>
      </div>
    `;
  }
  return html`
    <div class="dashboard-notes" data-test-id="dashboard-notes">
      <textarea
        class="dashboard-notes__pad"
        data-test-id="dashboard-notes-pad"
        aria-label=${widget.title}
        placeholder=${placeholder}
        ${ref(bindNotesEditor(ctx.state))}
      ></textarea>
    </div>
  `;
}
