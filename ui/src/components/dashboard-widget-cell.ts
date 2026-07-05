// Cell chrome for a dashboard widget: title bar, collapse toggle, kebab menu,
// provenance badge, and a per-cell error boundary. Pure render fns (workboard
// view idiom) — the Workspaces view owns state and passes callbacks in.
//
// The error boundary wraps the widget body render: a throw yields an error card in
// this cell only, so the shell and sibling widgets are unaffected (spec-30).

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../i18n/index.ts";
import { gridPlacementStyle } from "../lib/dashboard/grid.ts";
import { dashboardAgentProvenance, type DashboardBindingResult } from "../lib/dashboard/index.ts";
import type { DashboardWidget } from "../lib/dashboard/types.ts";
import { icons } from "./icons.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

export type DashboardWidgetCellCallbacks = {
  onToggleCollapse: (widget: DashboardWidget) => void;
  onToggleMenu: (widget: DashboardWidget) => void;
  onHide: (widget: DashboardWidget) => void;
  onRemove: (widget: DashboardWidget) => void;
  onEditTitle: (widget: DashboardWidget) => void;
  onMoveToTab: (widget: DashboardWidget) => void;
  onMovePointerDown: (widget: DashboardWidget, event: PointerEvent) => void;
  onResizePointerDown: (widget: DashboardWidget, event: PointerEvent) => void;
  onKeyboardNudge: (
    widget: DashboardWidget,
    mode: "move" | "resize",
    direction: "left" | "right" | "up" | "down",
  ) => void;
};

export type DashboardWidgetCellProps = {
  widget: DashboardWidget;
  /** Resolved binding value for the primary binding, or an error to surface. */
  binding: DashboardBindingResult | null;
  menuOpen: boolean;
  pending: boolean;
  /** When set, this cell is the live drag/resize ghost source. */
  dragging: boolean;
  callbacks: DashboardWidgetCellCallbacks;
};

/** Renders the provenance chip when a widget was authored by an agent. */
function renderProvenanceChip(widget: DashboardWidget): TemplateResult | typeof nothing {
  const agentId = dashboardAgentProvenance(widget.createdBy);
  if (!agentId) {
    return nothing;
  }
  return html`<span
    class="dashboard-widget__provenance"
    title=${t("dashboard.widget.provenanceTooltip", { agent: agentId })}
    >${t("dashboard.widget.provenanceChip")}</span
  >`;
}

function renderMenu(
  widget: DashboardWidget,
  callbacks: DashboardWidgetCellCallbacks,
): TemplateResult {
  return html`
    <div class="dashboard-widget__menu" role="menu">
      <button
        class="dashboard-widget__menu-item"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onEditTitle(widget)}
      >
        ${t("dashboard.widget.menu.editTitle")}
      </button>
      <button
        class="dashboard-widget__menu-item"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onMoveToTab(widget)}
      >
        ${t("dashboard.widget.menu.moveToTab")}
      </button>
      <button
        class="dashboard-widget__menu-item"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onHide(widget)}
      >
        ${t("dashboard.widget.menu.hide")}
      </button>
      <button
        class="dashboard-widget__menu-item dashboard-widget__menu-item--danger"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onRemove(widget)}
      >
        ${t("dashboard.widget.menu.remove")}
      </button>
    </div>
  `;
}

/** Renders the minimal builtin widget bodies (spec-30 scope: stat-card, markdown). */
export function renderBuiltinWidget(
  widget: DashboardWidget,
  binding: DashboardBindingResult | null,
): TemplateResult {
  const kind = widget.kind.startsWith("builtin:")
    ? widget.kind.slice("builtin:".length)
    : widget.kind;
  if (binding && "error" in binding) {
    // A binding failure is data-level, not a render throw: show it inline so the
    // widget stays mounted and refetches on the next broadcast.
    throw new Error(binding.error);
  }
  const value = binding && "value" in binding ? binding.value : undefined;
  switch (kind) {
    case "stat-card":
      return renderStatCard(widget, value);
    case "markdown":
      return renderMarkdown(widget, value);
    default:
      if (widget.kind.startsWith("custom:")) {
        // L5 replaces this with the sandboxed iframe host.
        return html`<div class="dashboard-widget__placeholder">
          ${t("dashboard.widget.customPlaceholder")}
        </div>`;
      }
      return html`<div class="dashboard-widget__placeholder">
        ${t("dashboard.widget.unknownKind", { kind: widget.kind })}
      </div>`;
  }
}

function formatStat(value: unknown, format: unknown): string {
  if (value === undefined || value === null) {
    return "—";
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (format === "usd" && Number.isFinite(numeric)) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(numeric);
  }
  if (format === "percent" && Number.isFinite(numeric)) {
    return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(
      numeric,
    );
  }
  return typeof value === "string" ? value : String(value);
}

function renderStatCard(widget: DashboardWidget, value: unknown): TemplateResult {
  const props = widget.props ?? {};
  const label = typeof props.label === "string" ? props.label : widget.title;
  const resolved = value !== undefined ? value : props.value;
  return html`
    <div class="dashboard-stat">
      <div class="dashboard-stat__value">${formatStat(resolved, props.format)}</div>
      <div class="dashboard-stat__label">${label}</div>
    </div>
  `;
}

function renderMarkdown(widget: DashboardWidget, value: unknown): TemplateResult {
  const props = widget.props ?? {};
  const source =
    typeof value === "string"
      ? value
      : typeof props.markdown === "string"
        ? props.markdown
        : typeof props.text === "string"
          ? props.text
          : "";
  if (!source.trim()) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.markdownEmpty")}
    </div>`;
  }
  return html`<div class="dashboard-markdown markdown-body">
    ${unsafeHTML(toSanitizedMarkdownHtml(source))}
  </div>`;
}

/**
 * Error boundary around the widget body. Any throw during the builtin render (a
 * broken widget, a bad binding) is caught and rendered as an error card in THIS
 * cell — siblings and the shell keep rendering (spec-30 acceptance criterion).
 */
export function renderWidgetBody(
  widget: DashboardWidget,
  binding: DashboardBindingResult | null,
  callbacks: DashboardWidgetCellCallbacks,
): TemplateResult {
  try {
    return renderBuiltinWidget(widget, binding);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return html`
      <div class="dashboard-widget__error" role="alert" data-test-id="dashboard-widget-error">
        <div class="dashboard-widget__error-title">${t("dashboard.widget.errorTitle")}</div>
        <div class="dashboard-widget__error-message">${message}</div>
        <button class="btn btn--small" type="button" @click=${() => callbacks.onRemove(widget)}>
          ${t("dashboard.widget.menu.remove")}
        </button>
      </div>
    `;
  }
}

export function renderWidgetCell(props: DashboardWidgetCellProps): TemplateResult {
  const { widget, callbacks } = props;
  const classes = [
    "dashboard-widget",
    widget.collapsed ? "dashboard-widget--collapsed" : "",
    props.pending ? "dashboard-widget--pending" : "",
    props.dragging ? "dashboard-widget--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <section
      class=${classes}
      style=${gridPlacementStyle(widget.grid)}
      data-widget-id=${widget.id}
      data-test-id="dashboard-widget"
    >
      <header
        class="dashboard-widget__bar"
        @pointerdown=${(event: PointerEvent) => callbacks.onMovePointerDown(widget, event)}
      >
        <button
          class="dashboard-widget__collapse"
          type="button"
          aria-expanded=${widget.collapsed ? "false" : "true"}
          aria-label=${widget.collapsed
            ? t("dashboard.widget.expand")
            : t("dashboard.widget.collapse")}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @click=${() => callbacks.onToggleCollapse(widget)}
        >
          ${widget.collapsed ? icons.chevronRight : icons.chevronDown}
        </button>
        <span class="dashboard-widget__title" title=${widget.title}>${widget.title}</span>
        ${renderProvenanceChip(widget)}
        <span
          class="dashboard-widget__handle"
          role="button"
          tabindex="0"
          aria-label=${t("dashboard.widget.moveHandle")}
          @keydown=${(event: KeyboardEvent) => handleNudgeKey(event, widget, "move", callbacks)}
          >${icons.arrowUpDown}</span
        >
        <button
          class="dashboard-widget__menu-toggle"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${props.menuOpen ? "true" : "false"}
          aria-label=${t("dashboard.widget.menuLabel")}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @click=${() => callbacks.onToggleMenu(widget)}
        >
          ${icons.moreHorizontal}
        </button>
        ${props.menuOpen ? renderMenu(widget, callbacks) : nothing}
      </header>
      ${widget.collapsed
        ? nothing
        : html`
            <div class="dashboard-widget__body">
              ${renderWidgetBody(widget, props.binding, callbacks)}
            </div>
            <span
              class="dashboard-widget__resize"
              role="button"
              tabindex="0"
              aria-label=${t("dashboard.widget.resizeHandle")}
              @pointerdown=${(event: PointerEvent) => callbacks.onResizePointerDown(widget, event)}
              @keydown=${(event: KeyboardEvent) =>
                handleNudgeKey(event, widget, "resize", callbacks)}
            ></span>
          `}
    </section>
  `;
}

/** Keyboard fallback for move/resize (a11y): arrow keys nudge by one grid unit. */
function handleNudgeKey(
  event: KeyboardEvent,
  widget: DashboardWidget,
  mode: "move" | "resize",
  callbacks: DashboardWidgetCellCallbacks,
): void {
  const direction =
    event.key === "ArrowLeft"
      ? "left"
      : event.key === "ArrowRight"
        ? "right"
        : event.key === "ArrowUp"
          ? "up"
          : event.key === "ArrowDown"
            ? "down"
            : null;
  if (!direction) {
    return;
  }
  event.preventDefault();
  callbacks.onKeyboardNudge(widget, mode, direction);
}
