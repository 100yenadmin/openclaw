// Control UI view renders the Workspaces bundled tab: tab strip, widget grid with
// hand-rolled pointer drag/drop + resize, empty states. Pure render fns — the
// controller owns lifecycle and `lib/dashboard` owns data logic.

import { html, nothing, render, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  loadWidgetManifestView,
  type CustomWidgetHostContext,
} from "../../components/dashboard-custom-widget.ts";
import {
  renderWidgetCell,
  type DashboardCustomWidgetContext,
  type DashboardWidgetCellCallbacks,
} from "../../components/dashboard-widget-cell.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  beginDrag,
  collides,
  DASHBOARD_GRID_GAP,
  DASHBOARD_ROW_HEIGHT,
  gridPlacementStyle,
  gridRowCount,
  nudgeRect,
  resolveDrop,
  updateDrag,
  type DashboardDragState,
} from "../../lib/dashboard/grid.ts";
import {
  approveWidget,
  clearActiveDrag,
  customWidgetName,
  customWidgetStatus,
  findTab,
  getDashboardState,
  hiddenTabs,
  hideWidget,
  loadWorkspace,
  moveWidget,
  moveWidgetToTab,
  removeWidgetFromTab,
  resolveActiveSlug,
  registerActiveDrag,
  resolveBinding,
  setWidgetCollapsed,
  startBindingPolling,
  subscribeToDashboardEvents,
  updateWidgetTitle,
  visibleTabs,
  type DashboardBindingResult,
  type DashboardUiState,
} from "../../lib/dashboard/index.ts";
import type {
  DashboardBinding,
  DashboardTab,
  DashboardWidget,
  DashboardWorkspace,
  WidgetManifestView,
} from "../../lib/dashboard/types.ts";
import type { BuiltinWidgetContext } from "../../lib/dashboard/widgets/index.ts";
import { pluginTabRefFromSearch } from "./route.ts";

export type DashboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  /** Control UI embed policy for the iframe-embed builtin (defaults to strict). */
  embed?: BuiltinWidgetContext["embed"];
  onRequestUpdate?: () => void;
  /** Gateway HTTP base path for custom-widget iframe sources (L5). */
  basePath?: string;
  /** Session key for custom-widget prompt dispatch (L5). */
  sessionKey?: string;
};

const DEFAULT_EMBED_CONTEXT: BuiltinWidgetContext["embed"] = {
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
};

// Per-host transient view state (menu, live drag) kept outside the data model so a
// broadcast refetch never clobbers an open menu or an in-flight drag.
type DashboardViewState = {
  openMenuWidgetId: string | null;
  drag: DashboardDragState | null;
  /** Resolved binding cache keyed by widgetId; refreshed when the doc changes. */
  bindingResults: Map<string, DashboardBindingResult>;
  bindingLoads: Set<string>;
  bindingVersion: number;
  /** Loaded custom-widget manifests keyed by widget name; survives doc changes. */
  manifestCache: Map<string, WidgetManifestView>;
  manifestLoads: Set<string>;
  /**
   * Monotonic data-refresh counter bumped by the per-widget polling timer.
   * Folded into the binding cache key so a poll tick re-resolves data-widget
   * bindings without a workspace-version change.
   */
  dataVersion: number;
};

const dashboardViewStates = new WeakMap<object, DashboardViewState>();

// Per-host document dismiss listener for the open kebab menu (#3). Installed while
// a menu is open so an outside pointerdown or Escape closes it; removed when the
// menu closes or the view stops. The details-based hidden-tabs menu closes via its
// own native outside-click/Escape once we drop `open` on the same signals.
type MenuDismissBinding = {
  onPointerDown: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
};
const dashboardMenuDismiss = new WeakMap<object, MenuDismissBinding>();

/** Remove the active menu-dismiss document listeners for `host`, if any. */
function teardownMenuDismiss(host: object): void {
  const binding = dashboardMenuDismiss.get(host);
  if (!binding) {
    return;
  }
  document.removeEventListener("pointerdown", binding.onPointerDown, true);
  document.removeEventListener("keydown", binding.onKeyDown, true);
  dashboardMenuDismiss.delete(host);
}

/**
 * Ensure the document-level dismiss listeners match whether a kebab menu is open.
 * When open, an outside pointerdown or Escape clears `openMenuWidgetId`; a click
 * inside the open menu/toggle is ignored so menu items still fire.
 */
function syncMenuDismiss(
  host: object,
  viewState: DashboardViewState,
  requestUpdate: () => void,
): void {
  const menuOpen = viewState.openMenuWidgetId !== null;
  const active = dashboardMenuDismiss.has(host);
  if (menuOpen === active) {
    return;
  }
  if (!menuOpen) {
    teardownMenuDismiss(host);
    return;
  }
  const close = () => {
    if (viewState.openMenuWidgetId === null) {
      return;
    }
    viewState.openMenuWidgetId = null;
    teardownMenuDismiss(host);
    requestUpdate();
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".dashboard-widget__menu, .dashboard-widget__menu-toggle")
    ) {
      return;
    }
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  dashboardMenuDismiss.set(host, { onPointerDown, onKeyDown });
}

/** View-level teardown: drop any menu-dismiss listeners. Called from the controller's stop. */
export function stopDashboardView(host: object): void {
  teardownMenuDismiss(host);
}

function getViewState(host: object): DashboardViewState {
  let state = dashboardViewStates.get(host);
  if (!state) {
    state = {
      openMenuWidgetId: null,
      drag: null,
      bindingResults: new Map(),
      bindingLoads: new Set(),
      bindingVersion: -1,
      manifestCache: new Map(),
      manifestLoads: new Set(),
      dataVersion: 0,
    };
    dashboardViewStates.set(host, state);
  }
  return state;
}

/** Read the current data-refresh counter for a host (used by the poll timer). */
export function dashboardDataVersion(host: object): number {
  return getViewState(host).dataVersion;
}

/** Advance the data-refresh counter so the next render re-resolves bindings. */
export function bumpDashboardDataVersion(host: object): void {
  getViewState(host).dataVersion += 1;
}

/** The workspace tab slug requested via the `?ws=` deep-link query param. */
export function requestedWorkspaceSlug(search: string): string | null {
  const params = new URLSearchParams(search);
  const ws = params.get("ws")?.trim();
  return ws ? ws : null;
}

/** Deep-link to a workspace tab: update `?ws=` and drive the router via popstate. */
export function navigateToWorkspaceTab(slug: string): void {
  const url = new URL(window.location.href);
  const ref = pluginTabRefFromSearch(url.search);
  url.searchParams.set("plugin", ref.pluginId);
  url.searchParams.set("id", ref.id);
  url.searchParams.set("ws", slug);
  window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Primary binding for a widget (first declared), if any. */
function primaryBinding(widget: DashboardWidget): DashboardBinding | null {
  const bindings = widget.bindings;
  if (!bindings) {
    return null;
  }
  const first = Object.values(bindings)[0];
  return first ?? null;
}

/**
 * Cache key mixing the workspace version with the data-refresh counter: a doc
 * change OR a poll tick both invalidate resolved bindings. Overflow-safe: only
 * equality is compared.
 */
function bindingCacheKey(workspace: DashboardWorkspace, viewState: DashboardViewState): number {
  return workspace.workspaceVersion * 1_000_003 + viewState.dataVersion;
}

/** Kick off binding resolution for widgets on the active tab; cache per version. */
function ensureBindings(
  viewState: DashboardViewState,
  client: GatewayBrowserClient | null,
  workspace: DashboardWorkspace,
  tab: DashboardTab,
  requestUpdate: (() => void) | null,
): void {
  const key = bindingCacheKey(workspace, viewState);
  if (viewState.bindingVersion !== key) {
    viewState.bindingResults.clear();
    viewState.bindingLoads.clear();
    viewState.bindingVersion = key;
  }
  for (const widget of tab.widgets) {
    const binding = primaryBinding(widget);
    if (
      !binding ||
      viewState.bindingResults.has(widget.id) ||
      viewState.bindingLoads.has(widget.id)
    ) {
      continue;
    }
    viewState.bindingLoads.add(widget.id);
    void resolveBinding(client, binding).then((result) => {
      viewState.bindingResults.set(widget.id, result);
      viewState.bindingLoads.delete(widget.id);
      requestUpdate?.();
    });
  }
}

function gridMetrics(host: object): { width: number } {
  const grid =
    host instanceof HTMLElement ? host.querySelector<HTMLElement>(".dashboard-grid") : null;
  return { width: grid?.clientWidth ?? 0 };
}

/**
 * Close the hidden-tabs overflow `<details>` on Escape (#3). Native details close
 * on summary click but not on Escape, so wire it explicitly.
 */
function onHiddenTabsKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") {
    return;
  }
  const details = (event.currentTarget as HTMLElement).closest("details");
  if (details?.open) {
    event.preventDefault();
    details.open = false;
    (details.querySelector("summary") as HTMLElement | null)?.focus();
  }
}

/**
 * When the hidden-tabs overflow opens, arm a one-shot document pointerdown that
 * closes it on an outside click (#3); native details never dismiss on outside
 * click. Self-removing on close so no listener leaks.
 */
function onHiddenTabsToggle(event: Event): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (!details.open) {
    return;
  }
  const onOutside = (pointerEvent: PointerEvent) => {
    if (pointerEvent.target instanceof Node && details.contains(pointerEvent.target)) {
      return;
    }
    details.open = false;
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onClosed = () => {
    if (!details.open) {
      document.removeEventListener("pointerdown", onOutside, true);
      details.removeEventListener("toggle", onClosed);
    }
  };
  document.addEventListener("pointerdown", onOutside, true);
  details.addEventListener("toggle", onClosed);
}

function renderTabStrip(state: DashboardUiState, workspace: DashboardWorkspace): TemplateResult {
  const tabs = visibleTabs(workspace);
  const hidden = hiddenTabs(workspace);
  return html`
    <nav class="dashboard-tabs" role="tablist" aria-label=${t("dashboard.tabs.label")}>
      ${tabs.map((tab) => {
        const active = tab.slug === state.activeSlug;
        return html`
          <button
            class="dashboard-tab ${active ? "dashboard-tab--active" : ""}"
            type="button"
            role="tab"
            aria-selected=${active ? "true" : "false"}
            data-test-id="dashboard-tab"
            data-ws=${tab.slug}
            @click=${() => navigateToWorkspaceTab(tab.slug)}
          >
            ${tab.icon && Object.hasOwn(icons, tab.icon)
              ? html`<span class="dashboard-tab__icon" aria-hidden="true"
                  >${icons[tab.icon as keyof typeof icons]}</span
                >`
              : nothing}
            <span class="dashboard-tab__label">${tab.title}</span>
          </button>
        `;
      })}
      ${hidden.length > 0
        ? html`
            <details
              class="dashboard-tabs__hidden"
              @toggle=${onHiddenTabsToggle}
              @keydown=${onHiddenTabsKeydown}
            >
              <summary class="dashboard-tab dashboard-tab--overflow">
                <span class="dashboard-tab__icon" aria-hidden="true">${icons.eyeOff}</span>
                <span class="dashboard-tab__label"
                  >${t("dashboard.tabs.hidden", { count: String(hidden.length) })}</span
                >
              </summary>
              <div class="dashboard-tabs__hidden-menu" role="menu">
                ${hidden.map(
                  (tab) => html`
                    <button
                      class="dashboard-tabs__hidden-item"
                      type="button"
                      role="menuitem"
                      @click=${() => navigateToWorkspaceTab(tab.slug)}
                    >
                      ${tab.title}
                    </button>
                  `,
                )}
              </div>
            </details>
          `
        : nothing}
    </nav>
  `;
}

/**
 * Load `widget.json` manifests for the APPROVED custom widgets on the active tab.
 * Only approved widgets ever build an iframe, so only they need a manifest; a
 * pending/rejected widget never fetches one. Cached across doc changes by name.
 */
function ensureManifests(
  viewState: DashboardViewState,
  props: DashboardProps,
  workspace: DashboardWorkspace,
  tab: DashboardTab,
): void {
  const basePath = props.basePath ?? "";
  for (const widget of tab.widgets) {
    const name = customWidgetName(widget.kind);
    if (
      !name ||
      customWidgetStatus(workspace, widget.kind) !== "approved" ||
      viewState.manifestCache.has(name) ||
      viewState.manifestLoads.has(name)
    ) {
      continue;
    }
    viewState.manifestLoads.add(name);
    void loadWidgetManifestView(basePath, name).then((manifest) => {
      viewState.manifestLoads.delete(name);
      if (manifest) {
        viewState.manifestCache.set(name, manifest);
        props.onRequestUpdate?.();
      }
    });
  }
}

/** Builds the L5 custom-widget context for one `custom:<name>` widget, or null. */
function buildCustomContext(
  props: DashboardProps,
  state: DashboardUiState,
  viewState: DashboardViewState,
  workspace: DashboardWorkspace,
  widget: DashboardWidget,
): DashboardCustomWidgetContext | null {
  const name = customWidgetName(widget.kind);
  if (!name) {
    return null;
  }
  const host: CustomWidgetHostContext = {
    client: props.client,
    basePath: props.basePath ?? "",
    sessionKey: props.sessionKey ?? "main",
  };
  return {
    status: customWidgetStatus(workspace, widget.kind),
    manifest: viewState.manifestCache.get(name) ?? null,
    host,
    onApprove: () => void approveWidget(state, props.client, { name, decision: "approved" }),
    onReject: () => void approveWidget(state, props.client, { name, decision: "rejected" }),
  };
}

function renderGrid(
  props: DashboardProps,
  state: DashboardUiState,
  viewState: DashboardViewState,
  workspace: DashboardWorkspace,
  tab: DashboardTab,
): TemplateResult {
  ensureBindings(viewState, props.client, workspace, tab, props.onRequestUpdate ?? null);
  ensureManifests(viewState, props, workspace, tab);
  if (tab.widgets.length === 0) {
    return html`
      <div class="dashboard-empty" data-test-id="dashboard-empty-tab">
        <div class="dashboard-empty__title">${t("dashboard.empty.tabTitle")}</div>
        <div class="dashboard-empty__sub">${t("dashboard.empty.tabSubtitle")}</div>
      </div>
    `;
  }
  const callbacks = makeCallbacks(props, state, viewState, tab);
  const builtinContext: BuiltinWidgetContext = { embed: props.embed ?? DEFAULT_EMBED_CONTEXT };
  const rows = gridRowCount(tab.widgets);
  const minHeight = rows * DASHBOARD_ROW_HEIGHT + Math.max(0, rows - 1) * DASHBOARD_GRID_GAP;
  return html`
    <div class="dashboard-grid" style="min-height: ${minHeight}px" data-test-id="dashboard-grid">
      ${tab.widgets.map((widget) => {
        const custom = buildCustomContext(props, state, viewState, workspace, widget);
        return renderWidgetCell({
          widget,
          binding: viewState.bindingResults.get(widget.id) ?? null,
          menuOpen: viewState.openMenuWidgetId === widget.id,
          pending: state.pendingWidgetIds.has(widget.id),
          dragging: viewState.drag?.widgetId === widget.id,
          builtinContext,
          callbacks,
          ...(custom ? { custom } : {}),
        });
      })}
      ${renderDragGhost(viewState, tab)}
    </div>
  `;
}

/**
 * Snapped drop-target ghost for the active move/resize drag (#4). Placed in the
 * same grid slot the drop would land in so the target is obvious. An overlapping
 * (reject-bound) target reads distinctly via `--invalid`.
 */
function renderDragGhost(
  viewState: DashboardViewState,
  tab: DashboardTab,
): TemplateResult | typeof nothing {
  const drag = viewState.drag;
  if (!drag) {
    return nothing;
  }
  const invalid = collides(drag.ghostRect, tab.widgets, drag.widgetId);
  return html`
    <div
      class="dashboard-ghost ${invalid ? "dashboard-ghost--invalid" : ""}"
      style=${gridPlacementStyle(drag.ghostRect)}
      aria-hidden="true"
      data-test-id="dashboard-drag-ghost"
    ></div>
  `;
}

function makeCallbacks(
  props: DashboardProps,
  state: DashboardUiState,
  viewState: DashboardViewState,
  tab: DashboardTab,
): DashboardWidgetCellCallbacks {
  const requestUpdate = () => props.onRequestUpdate?.();
  const commitDrag = (widget: DashboardWidget, event: PointerEvent, mode: "move" | "resize") => {
    const metrics = gridMetrics(props.host);
    if (metrics.width <= 0) {
      return;
    }
    const drag = beginDrag({
      widget,
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      metrics,
    });
    viewState.drag = drag;
    const target = event.target as Element;
    if (target.setPointerCapture) {
      target.setPointerCapture(event.pointerId);
    }
    // Once cancelled (tab-switch/disconnect via stopDashboard), the window
    // listeners are removed and any late pointerup becomes a no-op so it cannot
    // fire moveWidget against a stale tab/client.
    let settled = false;
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const cancel = () => {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      viewState.drag = null;
      requestUpdate();
    };
    const onMove = (moveEvent: PointerEvent) => {
      updateDrag(drag, moveEvent.clientX, moveEvent.clientY);
      requestUpdate();
    };
    const onUp = () => {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      clearActiveDrag(props.host);
      const resolved = resolveDrop({
        requested: drag.ghostRect,
        widgets: tab.widgets,
        widgetId: widget.id,
      });
      viewState.drag = null;
      requestUpdate();
      if (
        resolved &&
        (resolved.x !== widget.grid.x ||
          resolved.y !== widget.grid.y ||
          resolved.w !== widget.grid.w ||
          resolved.h !== widget.grid.h)
      ) {
        void moveWidget(state, props.client, {
          slug: tab.slug,
          widgetId: widget.id,
          grid: resolved,
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    registerActiveDrag(props.host, cancel);
  };
  return {
    onToggleCollapse: (widget) =>
      void setWidgetCollapsed(state, props.client, {
        slug: tab.slug,
        widgetId: widget.id,
        collapsed: !widget.collapsed,
      }),
    onToggleMenu: (widget) => {
      viewState.openMenuWidgetId = viewState.openMenuWidgetId === widget.id ? null : widget.id;
      requestUpdate();
    },
    onHide: (widget) => {
      viewState.openMenuWidgetId = null;
      // Hiding removes the widget from view and persists the hidden flag; distinct
      // from remove, which deletes it from the document.
      void hideWidget(state, props.client, { slug: tab.slug, widgetId: widget.id });
    },
    onRemove: (widget) => {
      viewState.openMenuWidgetId = null;
      void removeWidgetFromTab(state, props.client, { slug: tab.slug, widgetId: widget.id });
    },
    onEditTitle: (widget) => {
      viewState.openMenuWidgetId = null;
      const next = window.prompt(t("dashboard.widget.editTitlePrompt"), widget.title);
      if (next !== null && next.trim() && next !== widget.title) {
        void updateWidgetTitle(state, props.client, {
          slug: tab.slug,
          widgetId: widget.id,
          title: next.trim(),
        });
      }
    },
    onMoveToTab: (widget) => {
      viewState.openMenuWidgetId = null;
      const targetSlug = window.prompt(t("dashboard.widget.moveToTabPrompt"));
      if (targetSlug !== null && targetSlug.trim() && targetSlug.trim() !== tab.slug) {
        void moveWidgetToTab(state, props.client, {
          fromSlug: tab.slug,
          toSlug: targetSlug.trim(),
          widgetId: widget.id,
        });
      }
    },
    onMovePointerDown: (widget, event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      commitDrag(widget, event, "move");
    },
    onResizePointerDown: (widget, event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitDrag(widget, event, "resize");
    },
    onKeyboardNudge: (widget, mode, direction) => {
      const next = nudgeRect(widget.grid, mode, direction);
      const resolved = resolveDrop({ requested: next, widgets: tab.widgets, widgetId: widget.id });
      if (resolved) {
        void moveWidget(state, props.client, {
          slug: tab.slug,
          widgetId: widget.id,
          grid: resolved,
        });
      }
    },
  };
}

export function renderDashboard(props: DashboardProps): TemplateResult {
  const state = getDashboardState(props.host);
  const viewState = getViewState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  // Keep the outside-click / Escape dismiss listeners in sync with the open kebab
  // menu (#3). Cheap no-op when the open state is unchanged.
  syncMenuDismiss(props.host, viewState, () => props.onRequestUpdate?.());

  const requestedSlug = requestedWorkspaceSlug(window.location.search);
  const active = props.connected;
  subscribeToDashboardEvents(props.host, state, active ? props.client : null);
  // Per-widget data refresh: a visibility-gated timer bumps the data version so
  // the next render re-resolves data-widget bindings. stopDashboard clears it on
  // tab-leave/disconnect (logbook's stop discipline — no orphan timers).
  startBindingPolling(props.host, active ? props.client : null, () => {
    bumpDashboardDataVersion(props.host);
    props.onRequestUpdate?.();
  });
  if (active && !state.loaded && !state.loading && !state.error) {
    void loadWorkspace(state, props.client, { requestedSlug });
  }

  // Deep-link: a changed `?ws=` re-points the active tab without a refetch.
  if (state.workspace && requestedSlug && requestedSlug !== state.activeSlug) {
    state.activeSlug = resolveActiveSlug(state.workspace, requestedSlug);
  }

  return html`
    <section class="dashboard" data-test-id="dashboard">
      ${state.actionError
        ? html`<div class="callout danger dashboard__toast" role="alert">${state.actionError}</div>`
        : nothing}
      ${renderBody(props, state, viewState)}
    </section>
  `;
}

function renderBody(
  props: DashboardProps,
  state: DashboardUiState,
  viewState: DashboardViewState,
): TemplateResult {
  if (state.error) {
    return html`
      <div class="card lazy-view-state" role="alert">
        <div class="card-title">${t("dashboard.error.title")}</div>
        <div class="card-sub">${state.error}</div>
        <button
          class="btn btn--small"
          type="button"
          @click=${() => void loadWorkspace(state, props.client)}
        >
          ${t("common.reload")}
        </button>
      </div>
    `;
  }
  const workspace = state.workspace;
  if (!workspace) {
    return html`<div class="card lazy-view-state" role="status">
      <div class="card-sub">${t("common.loading")}</div>
    </div>`;
  }
  if (workspace.tabs.length === 0) {
    return html`
      <div class="dashboard-empty dashboard-empty--onboarding" data-test-id="dashboard-empty">
        <div class="dashboard-empty__title">${t("dashboard.empty.onboardingTitle")}</div>
        <div class="dashboard-empty__sub">${t("dashboard.empty.onboardingSubtitle")}</div>
        <code class="dashboard-empty__cmd">${t("dashboard.empty.onboardingCommand")}</code>
      </div>
    `;
  }
  const tab = findTab(workspace, state.activeSlug) ?? visibleTabs(workspace)[0];
  if (!tab) {
    return html`<div class="card lazy-view-state" role="status">
      <div class="card-sub">${t("dashboard.empty.noVisibleTabs")}</div>
    </div>`;
  }
  return html`
    ${renderTabStrip(state, workspace)} ${renderGrid(props, state, viewState, workspace, tab)}
  `;
}

// Re-exported for tests that render the view into a detached container.
export { render };
