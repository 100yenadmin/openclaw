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
  DASHBOARD_GRID_GAP,
  DASHBOARD_ROW_HEIGHT,
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
import { pluginTabRefFromSearch } from "./route.ts";

export type DashboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
  /** Gateway HTTP base path for custom-widget iframe sources (L5). */
  basePath?: string;
  /** Session key for custom-widget prompt dispatch (L5). */
  sessionKey?: string;
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
};

const dashboardViewStates = new WeakMap<object, DashboardViewState>();

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
    };
    dashboardViewStates.set(host, state);
  }
  return state;
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

/** Kick off binding resolution for widgets on the active tab; cache per version. */
function ensureBindings(
  viewState: DashboardViewState,
  client: GatewayBrowserClient | null,
  workspace: DashboardWorkspace,
  tab: DashboardTab,
  requestUpdate: (() => void) | null,
): void {
  if (viewState.bindingVersion !== workspace.workspaceVersion) {
    viewState.bindingResults.clear();
    viewState.bindingLoads.clear();
    viewState.bindingVersion = workspace.workspaceVersion;
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
            <details class="dashboard-tabs__hidden">
              <summary class="dashboard-tab dashboard-tab--overflow">
                ${icons.eyeOff}
                <span>${t("dashboard.tabs.hidden", { count: String(hidden.length) })}</span>
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
          callbacks,
          ...(custom ? { custom } : {}),
        });
      })}
    </div>
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

  const requestedSlug = requestedWorkspaceSlug(window.location.search);
  const active = props.connected;
  subscribeToDashboardEvents(props.host, state, active ? props.client : null);
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
