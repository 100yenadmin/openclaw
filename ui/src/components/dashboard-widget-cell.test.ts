import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DashboardWidget, WidgetManifestView } from "../lib/dashboard/types.ts";
import {
  renderCustomWidget,
  renderWidgetBody,
  renderWidgetCell,
  type DashboardCustomWidgetContext,
  type DashboardWidgetCellCallbacks,
} from "./dashboard-widget-cell.ts";

function noopCallbacks(): DashboardWidgetCellCallbacks {
  return {
    onToggleCollapse: vi.fn(),
    onToggleMenu: vi.fn(),
    onHide: vi.fn(),
    onRemove: vi.fn(),
    onEditTitle: vi.fn(),
    onMoveToTab: vi.fn(),
    onMovePointerDown: vi.fn(),
    onResizePointerDown: vi.fn(),
    onKeyboardNudge: vi.fn(),
  };
}

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: "w1",
    kind: "builtin:stat-card",
    title: "Revenue",
    grid: { x: 0, y: 0, w: 4, h: 2 },
    collapsed: false,
    ...overrides,
  };
}

function renderToContainer(template: unknown): HTMLElement {
  const container = document.createElement("div");
  render(template as never, container);
  return container;
}

describe("dashboard widget cell", () => {
  it("renders the title bar with collapse and menu affordances", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget(),
        binding: { value: 1000 },
        menuOpen: false,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".dashboard-widget__title")?.textContent).toContain("Revenue");
    expect(container.querySelector(".dashboard-widget__collapse")).not.toBeNull();
    expect(container.querySelector(".dashboard-widget__menu-toggle")).not.toBeNull();
    // Not collapsed → body + resize handle present.
    expect(container.querySelector(".dashboard-widget__resize")).not.toBeNull();
  });

  it("renders a provenance chip for agent-authored widgets", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ createdBy: "agent:finance" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
      }),
    );
    const chip = container.querySelector(".dashboard-widget__provenance");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("title")).toContain("finance");
  });

  it("omits the provenance chip for user-authored widgets", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ createdBy: "user" }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".dashboard-widget__provenance")).toBeNull();
  });

  it("hides the body and resize handle when collapsed", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ collapsed: true }),
        binding: { value: 1 },
        menuOpen: false,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
      }),
    );
    expect(container.querySelector(".dashboard-widget__body")).toBeNull();
    expect(container.querySelector(".dashboard-widget__resize")).toBeNull();
  });

  it("opens the kebab menu with hide/remove/edit/move items", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget(),
        binding: { value: 1 },
        menuOpen: true,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
      }),
    );
    const items = container.querySelectorAll(".dashboard-widget__menu-item");
    expect(items.length).toBe(4);
  });

  it("renders a stat-card value formatted as currency", () => {
    const container = renderToContainer(
      renderWidgetBody(
        widget({ props: { format: "usd", label: "Q3 Revenue" } }),
        { value: 1234 },
        noopCallbacks(),
      ),
    );
    expect(container.querySelector(".dashboard-stat__value")?.textContent).toContain("$1,234");
    expect(container.querySelector(".dashboard-stat__label")?.textContent).toContain("Q3 Revenue");
  });

  it("renders markdown widget content", () => {
    const container = renderToContainer(
      renderWidgetBody(widget({ kind: "builtin:markdown" }), { value: "# Hello" }, noopCallbacks()),
    );
    expect(container.querySelector(".dashboard-markdown h1")?.textContent).toContain("Hello");
  });

  it("catches a widget render throw with a per-cell error card", () => {
    // A binding error triggers the error boundary; the card stays mounted.
    const container = renderToContainer(
      renderWidgetBody(widget(), { error: "binding failed" }, noopCallbacks()),
    );
    const errorCard = container.querySelector('[data-test-id="dashboard-widget-error"]');
    expect(errorCard).not.toBeNull();
    expect(errorCard?.textContent).toContain("binding failed");
  });

  it("renders a placeholder for custom widgets in L3", () => {
    const container = renderToContainer(
      renderWidgetBody(widget({ kind: "custom:chart" }), null, noopCallbacks()),
    );
    expect(container.querySelector(".dashboard-widget__placeholder")).not.toBeNull();
  });
});

function customManifest(): WidgetManifestView {
  return { name: "chart", bindingIds: ["value"], capabilities: ["data:read"] };
}

function customContext(
  overrides: Partial<DashboardCustomWidgetContext> = {},
): DashboardCustomWidgetContext {
  return {
    status: "approved",
    manifest: customManifest(),
    host: { client: null, basePath: "", sessionKey: "main" },
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
}

describe("renderCustomWidget (L5 dispatch)", () => {
  it("renders the sandboxed iframe host for an approved widget", () => {
    const container = renderToContainer(
      renderCustomWidget(widget({ kind: "custom:chart" }), customContext()),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("holds without an iframe when approved but the manifest has not loaded", () => {
    const container = renderToContainer(
      renderCustomWidget(widget({ kind: "custom:chart" }), customContext({ manifest: null })),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="dashboard-custom-loading"]')).not.toBeNull();
  });

  it("renders the pending approval card with Approve/Reject and NO iframe", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const container = renderToContainer(
      renderCustomWidget(
        widget({ kind: "custom:chart", createdBy: "agent:main" }),
        customContext({ status: "pending", manifest: null, onApprove, onReject }),
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    const pending = container.querySelector('[data-test-id="dashboard-custom-pending"]');
    expect(pending).not.toBeNull();
    container
      .querySelector<HTMLButtonElement>('[data-test-id="dashboard-custom-approve"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('[data-test-id="dashboard-custom-reject"]')?.click();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("renders a neutral placeholder (no iframe) for a rejected widget", () => {
    const container = renderToContainer(
      renderCustomWidget(widget({ kind: "custom:chart" }), customContext({ status: "rejected" })),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="dashboard-custom-rejected"]')).not.toBeNull();
  });

  it("never builds an iframe for a pending widget even via the full cell", () => {
    const container = renderToContainer(
      renderWidgetCell({
        widget: widget({ kind: "custom:chart" }),
        binding: null,
        menuOpen: false,
        pending: false,
        dragging: false,
        callbacks: noopCallbacks(),
        custom: customContext({ status: "pending", manifest: null }),
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-test-id="dashboard-custom-pending"]')).not.toBeNull();
  });
});
