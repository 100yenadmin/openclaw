import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { getDashboardState } from "../../lib/dashboard/index.ts";
import {
  navigateToWorkspaceTab,
  renderDashboard,
  requestedWorkspaceSlug,
} from "./dashboard-view.ts";

function renderView(host: object): HTMLElement {
  const container = document.createElement("div");
  // The view queries `.dashboard-grid` on the host for grid metrics.
  const el = container as unknown as object;
  render(renderDashboard({ host: el, client: null, connected: false }), container);
  render(renderDashboard({ host, client: null, connected: false }), container);
  return container;
}

const doc = {
  schemaVersion: 1,
  workspaceVersion: 1,
  tabs: [
    {
      slug: "main",
      title: "Main",
      hidden: false,
      widgets: [
        {
          id: "w1",
          kind: "builtin:markdown",
          title: "Notes",
          grid: { x: 0, y: 0, w: 6, h: 2 },
          collapsed: false,
          props: { markdown: "hello" },
        },
      ],
    },
    { slug: "hidden-one", title: "Hidden", hidden: true, widgets: [] },
    { slug: "empty", title: "Empty", hidden: false, widgets: [] },
  ],
  prefs: { tabOrder: ["main", "empty", "hidden-one"] },
};

describe("requestedWorkspaceSlug", () => {
  it("reads the ws deep-link param", () => {
    expect(requestedWorkspaceSlug("?plugin=dashboard&id=workspaces&ws=financials")).toBe(
      "financials",
    );
    expect(requestedWorkspaceSlug("?plugin=dashboard&id=workspaces")).toBeNull();
  });
});

describe("navigateToWorkspaceTab", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("pushes a ws query param and dispatches popstate", () => {
    window.history.replaceState({}, "", "/plugin?plugin=dashboard&id=workspaces");
    let popped = false;
    const onPop = () => {
      popped = true;
    };
    window.addEventListener("popstate", onPop);
    navigateToWorkspaceTab("financials");
    window.removeEventListener("popstate", onPop);
    expect(new URLSearchParams(window.location.search).get("ws")).toBe("financials");
    expect(popped).toBe(true);
  });
});

describe("renderDashboard", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("shows the onboarding empty state with no tabs", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [],
      prefs: { tabOrder: [] },
    };
    const container = renderView(host);
    expect(container.querySelector('[data-test-id="dashboard-empty"]')).not.toBeNull();
  });

  it("renders the tab strip with visible tabs and a hidden overflow", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    const container = renderView(host);
    const tabs = container.querySelectorAll('[data-test-id="dashboard-tab"]');
    expect(tabs.length).toBe(2); // main + empty (hidden-one is in overflow)
    expect(container.querySelector(".dashboard-tabs__hidden")).not.toBeNull();
    // Active tab's widget grid renders.
    expect(container.querySelector('[data-test-id="dashboard-grid"]')).not.toBeNull();
  });

  it("renders the empty-tab hint for a tab with no widgets", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "empty";
    const container = renderView(host);
    expect(container.querySelector('[data-test-id="dashboard-empty-tab"]')).not.toBeNull();
  });

  it("surfaces an action error toast", () => {
    const host = {};
    const state = getDashboardState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    state.actionError = "move failed";
    const container = renderView(host);
    expect(container.querySelector(".dashboard__toast")?.textContent).toContain("move failed");
  });
});
