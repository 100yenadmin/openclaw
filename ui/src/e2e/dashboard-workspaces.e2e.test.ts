// Control UI tests cover the Workspaces bundled tab (L3) end-to-end against a
// mocked Gateway: sidebar advertisement, deep-linking, live refetch, optimistic
// mutations with revert, and the per-cell error boundary.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

/** hello-ok payload including the dashboard control-ui tab (L1 stitches this live). */
function connectResponseWithDashboardTab() {
  return {
    auth: {
      deviceToken: "e2e-device-token",
      role: "operator",
      scopes: [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ],
    },
    controlUiTabs: [
      {
        pluginId: "dashboard",
        id: "workspaces",
        label: "Workspaces",
        group: "control",
        order: -10,
      },
    ],
    features: { events: ["plugin.dashboard.changed"], methods: ["dashboard.workspace.get"] },
    protocol: PROTOCOL_VERSION,
    server: { connId: "control-ui-e2e", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
  };
}

function workspaceDoc(version: number, overrides?: { widgets?: unknown[] }) {
  return {
    workspace: {
      schemaVersion: 1,
      workspaceVersion: version,
      tabs: [
        {
          slug: "financials",
          title: "Financials",
          hidden: false,
          createdBy: "agent:finance",
          widgets: overrides?.widgets ?? [
            {
              id: "w_rev",
              kind: "builtin:stat-card",
              title: "Q3 Revenue",
              grid: { x: 0, y: 0, w: 4, h: 2 },
              collapsed: false,
              createdBy: "agent:finance",
              props: { format: "usd", value: 125000, label: "Q3 Revenue" },
            },
            {
              id: "w_notes",
              kind: "builtin:markdown",
              title: "Notes",
              grid: { x: 4, y: 0, w: 8, h: 2 },
              collapsed: false,
              props: { markdown: "## Runway\nLooking healthy." },
            },
          ],
        },
        {
          slug: "ops",
          title: "Operations",
          hidden: false,
          widgets: [],
        },
      ],
      prefs: { tabOrder: ["financials", "ops"] },
    },
  };
}

type PageDiagnostics = { consoleMessages: string[]; pageErrors: string[] };

function trackDiagnostics(page: Page): PageDiagnostics {
  const diagnostics: PageDiagnostics = { consoleMessages: [], pageErrors: [] };
  page.on("pageerror", (err) => diagnostics.pageErrors.push(String(err)));
  page.on("console", (msg) => diagnostics.consoleMessages.push(`${msg.type()}: ${msg.text()}`));
  return diagnostics;
}

async function gotoWorkspaces(page: Page, e2eServer: ControlUiE2eServer, slug?: string) {
  const suffix = slug ? `&ws=${slug}` : "";
  const response = await page.goto(
    `${e2eServer.baseUrl}plugin?plugin=dashboard&id=workspaces${suffix}`,
  );
  expect(response?.status()).toBe(200);
}

describeControlUiE2e("Control UI Workspaces bundled tab mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("advertises the Workspaces sidebar tab and renders the default workspace", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": workspaceDoc(1),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      // Sidebar advertises the plugin tab.
      await page.locator(".nav-item__text", { hasText: "Workspaces" }).first().waitFor({
        timeout: 10_000,
      });
      // Default workspace renders its widgets.
      await page.locator('[data-test-id="dashboard-widget"]').first().waitFor({ timeout: 10_000 });
      await expect
        .poll(async () => page.locator('[data-test-id="dashboard-widget"]').count())
        .toBe(2);
      // Provenance chip for the agent-authored widget.
      await expect
        .poll(async () => page.locator(".dashboard-widget__provenance").count())
        .toBeGreaterThan(0);
      // Stat card formatted as currency.
      await expect
        .poll(async () => page.locator(".dashboard-stat__value").first().textContent())
        .toContain("$125,000");
    } finally {
      await context.close();
    }
  });

  it("deep-links to a workspace tab via the ws query param", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": workspaceDoc(1),
      },
    });
    try {
      await gotoWorkspaces(page, server, "ops");
      // The empty "ops" tab is active from the deep link.
      await page.locator('[data-test-id="dashboard-empty-tab"]').waitFor({ timeout: 10_000 });
      await expect
        .poll(async () =>
          page.locator('[data-test-id="dashboard-tab"][data-ws="ops"]').getAttribute("class"),
        )
        .toContain("dashboard-tab--active");
      // Clicking the financials tab updates the URL and view.
      await page.locator('[data-test-id="dashboard-tab"][data-ws="financials"]').click();
      await page.locator('[data-test-id="dashboard-grid"]').waitFor({ timeout: 10_000 });
      await expect.poll(async () => new URL(page.url()).searchParams.get("ws")).toBe("financials");
    } finally {
      await context.close();
    }
  });

  it("refetches and re-renders when plugin.dashboard.changed broadcasts a newer version", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": workspaceDoc(1),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      await expect
        .poll(async () => page.locator(".dashboard-stat__value").first().textContent())
        .toContain("$125,000");
      // Broadcast a newer version; the view refetches. Defer that refetch so we can
      // resolve it with the v2 document.
      await gateway.deferNext("dashboard.workspace.get");
      await gateway.emitGatewayEvent("plugin.dashboard.changed", { workspaceVersion: 2 });
      await gateway.resolveDeferred(
        "dashboard.workspace.get",
        workspaceDoc(2, {
          widgets: [
            {
              id: "w_rev",
              kind: "builtin:stat-card",
              title: "Q3 Revenue",
              grid: { x: 0, y: 0, w: 4, h: 2 },
              collapsed: false,
              props: { format: "usd", value: 200000, label: "Q3 Revenue" },
            },
          ],
        }),
      );
      await expect
        .poll(async () => page.locator(".dashboard-stat__value").first().textContent())
        .toContain("$200,000");
    } finally {
      await context.close();
    }
  });

  it("optimistically collapses a widget and reverts when the RPC fails", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": workspaceDoc(1),
      },
    });
    try {
      await gotoWorkspaces(page, server);
      const firstWidget = page.locator('[data-test-id="dashboard-widget"]').first();
      await firstWidget.waitFor({ timeout: 10_000 });
      // Defer the update so we can reject it and observe the revert.
      await gateway.deferNext("dashboard.widget.update");
      await firstWidget.locator(".dashboard-widget__collapse").click();
      await expect
        .poll(async () => firstWidget.getAttribute("class"))
        .toContain("dashboard-widget--collapsed");
      await gateway.rejectDeferred("dashboard.widget.update", { message: "nope" });
      // Reverts to expanded and shows the error toast.
      await expect
        .poll(async () => firstWidget.getAttribute("class"))
        .not.toContain("dashboard-widget--collapsed");
      await expect
        .poll(async () => page.locator(".dashboard__toast").textContent())
        .toContain("nope");
    } finally {
      await context.close();
    }
  });

  it("isolates a broken widget render to its own cell", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": {
          workspace: {
            schemaVersion: 1,
            workspaceVersion: 1,
            tabs: [
              {
                slug: "financials",
                title: "Financials",
                hidden: false,
                widgets: [
                  {
                    id: "w_broken",
                    kind: "builtin:stat-card",
                    title: "Broken",
                    grid: { x: 0, y: 0, w: 4, h: 2 },
                    collapsed: false,
                    // rpc binding whose method the mock rejects → error card.
                    bindings: { value: { source: "rpc", method: "dashboard.missing" } },
                  },
                  {
                    id: "w_ok",
                    kind: "builtin:markdown",
                    title: "Healthy",
                    grid: { x: 4, y: 0, w: 8, h: 2 },
                    collapsed: false,
                    props: { markdown: "still here" },
                  },
                ],
              },
            ],
            prefs: { tabOrder: ["financials"] },
          },
        },
      },
      deferredMethods: ["dashboard.missing"],
    });
    try {
      await gotoWorkspaces(page, server);
      await page.locator('[data-test-id="dashboard-widget"]').first().waitFor({ timeout: 10_000 });
      // Reject the broken widget's binding rpc → its cell renders an error card.
      await page.waitForFunction(() => {
        const gw = (
          window as unknown as {
            openclawControlUiE2eGateway?: { requests: Array<{ method: string }> };
          }
        ).openclawControlUiE2eGateway;
        return Boolean(gw?.requests.some((r) => r.method === "dashboard.missing"));
      });
      await rejectBinding(page, "dashboard.missing");
      await page.locator('[data-test-id="dashboard-widget-error"]').waitFor({ timeout: 10_000 });
      // The sibling widget still renders.
      await expect
        .poll(async () => page.locator(".dashboard-markdown").textContent())
        .toContain("still here");
      await expect
        .poll(async () => page.locator('[data-test-id="dashboard-widget"]').count())
        .toBe(2);
    } finally {
      await context.close();
    }
  });

  it("renders every builtin data widget from mocked RPC fixtures", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": defaultWorkspaceDoc(),
        ...DEFAULT_WORKSPACE_RPC_FIXTURES,
      },
    });
    try {
      await gotoWorkspaces(page, server);
      await page.locator('[data-test-id="dashboard-grid"]').waitFor({ timeout: 10_000 });
      // All six default widgets mount.
      await expect
        .poll(async () => page.locator('[data-test-id="dashboard-widget"]').count())
        .toBe(6);
      // Stat card renders today's cost from usage.cost totals.
      await expect
        .poll(async () => page.locator(".dashboard-stat__value").first().textContent())
        .toContain("$12");
      // Each data widget's list/feed root renders from its fixture.
      for (const testId of [
        "dashboard-sessions",
        "dashboard-cron",
        "dashboard-instances",
        "dashboard-activity",
      ]) {
        await page.locator(`[data-test-id="${testId}"]`).first().waitFor({ timeout: 10_000 });
      }
      // The sessions widget shows a live-run dot for the active session.
      await expect
        .poll(async () => page.locator(".dashboard-dot--live").count())
        .toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });

  it("renders per-widget empty states when RPCs return no rows", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": defaultWorkspaceDoc(),
        "usage.cost": { totals: { totalCost: 0, totalTokens: 0 } },
        "sessions.list": { sessions: [] },
        "cron.list": { jobs: [] },
        "cron.runs": { entries: [] },
        "system-presence": [],
      },
    });
    try {
      await gotoWorkspaces(page, server);
      await page.locator('[data-test-id="dashboard-grid"]').waitFor({ timeout: 10_000 });
      // Each empty data widget shows a placeholder rather than throwing.
      await expect
        .poll(async () => page.locator(".dashboard-widget__placeholder").count())
        .toBeGreaterThanOrEqual(4);
      // The shell never breaks: no error card, all six cells mounted.
      await expect
        .poll(async () => page.locator('[data-test-id="dashboard-widget-error"]').count())
        .toBe(0);
      await expect
        .poll(async () => page.locator('[data-test-id="dashboard-widget"]').count())
        .toBe(6);
    } finally {
      await context.close();
    }
  });

  it("shows a per-cell error card when a data widget's RPC fails, sibling stays live", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    trackDiagnostics(page);
    // A broken stat-card binds a deferred RPC the mock rejects, surfacing the
    // per-cell error boundary; the static markdown sibling proves the shell
    // isolates the failure (mirrors the L3 broken-widget scenario for a data
    // widget kind).
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": brokenWidgetDoc(),
      },
      deferredMethods: ["dashboard.missing"],
    });
    try {
      await gotoWorkspaces(page, server);
      await page.waitForFunction(() => {
        const gw = (
          window as unknown as {
            openclawControlUiE2eGateway?: { requests: Array<{ method: string }> };
          }
        ).openclawControlUiE2eGateway;
        return Boolean(gw?.requests.some((r) => r.method === "dashboard.missing"));
      });
      await rejectBinding(page, "dashboard.missing");
      // The broken cell shows an error card…
      await page.locator('[data-test-id="dashboard-widget-error"]').waitFor({ timeout: 10_000 });
      // …while the sibling markdown widget still renders.
      await expect
        .poll(async () => page.locator(".dashboard-markdown").textContent())
        .toContain("still here");
    } finally {
      await context.close();
    }
  });

  it("tears down cleanly when the Workspaces tab is left (no orphan RPC on leave)", async () => {
    // Timer-tick discipline is proven deterministically by the fake-timer unit
    // test in lib/dashboard/index.test.ts ("data-refresh polling"). Here we prove
    // the browser-level teardown: leaving the tab fires the bundled view's stop
    // hook and no further data RPC lands (the interval is cleared, not orphaned).
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const diagnostics = trackDiagnostics(page);
    await installMockGateway(page, {
      methodResponses: {
        connect: connectResponseWithDashboardTab(),
        "dashboard.workspace.get": defaultWorkspaceDoc(),
        ...DEFAULT_WORKSPACE_RPC_FIXTURES,
      },
    });
    try {
      await gotoWorkspaces(page, server);
      await page.locator('[data-test-id="dashboard-cron"]').waitFor({ timeout: 10_000 });
      const cronCallsWhileMounted = await countRpcCalls(page, "cron.list");
      expect(cronCallsWhileMounted).toBeGreaterThan(0);
      // Navigate away → stop hook clears the interval. Give any orphaned timer a
      // window to (wrongly) fire, then assert the data-RPC count did not grow.
      await page.goto(`${server.baseUrl}sessions`);
      const afterLeave = await countRpcCalls(page, "cron.list");
      await page.waitForTimeout(1500);
      expect(await countRpcCalls(page, "cron.list")).toBe(afterLeave);
      expect(diagnostics.pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

async function countRpcCalls(page: Page, method: string): Promise<number> {
  return page.evaluate((targetMethod) => {
    const gw = (
      window as unknown as {
        openclawControlUiE2eGateway?: { requests: Array<{ method: string }> };
      }
    ).openclawControlUiE2eGateway;
    return gw?.requests.filter((r) => r.method === targetMethod).length ?? 0;
  }, method);
}

/** The default `main` workspace doc with all six builtin widgets (L4). */
function defaultWorkspaceDoc() {
  return {
    workspace: {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [
        {
          slug: "main",
          title: "Overview",
          hidden: false,
          createdBy: "system",
          widgets: [
            {
              id: "cost-today",
              kind: "builtin:stat-card",
              title: "Cost Today",
              grid: { x: 0, y: 0, w: 4, h: 2 },
              collapsed: false,
              bindings: { value: { source: "rpc", method: "usage.cost" } },
              props: { metric: "todayCost", format: "usd" },
            },
            {
              id: "tokens-today",
              kind: "builtin:stat-card",
              title: "Tokens Today",
              grid: { x: 4, y: 0, w: 4, h: 2 },
              collapsed: false,
              bindings: { value: { source: "rpc", method: "usage.cost" } },
              props: { metric: "todayTokens", format: "int" },
            },
            {
              id: "instances-health",
              kind: "builtin:instances",
              title: "Instances",
              grid: { x: 8, y: 0, w: 4, h: 2 },
              collapsed: false,
              bindings: { presence: { source: "rpc", method: "system-presence" } },
            },
            {
              id: "sessions",
              kind: "builtin:sessions",
              title: "Sessions",
              grid: { x: 0, y: 2, w: 6, h: 5 },
              collapsed: false,
              bindings: { sessions: { source: "rpc", method: "sessions.list" } },
            },
            {
              id: "cron",
              kind: "builtin:cron",
              title: "Cron",
              grid: { x: 6, y: 2, w: 6, h: 5 },
              collapsed: false,
              bindings: { jobs: { source: "rpc", method: "cron.list" } },
            },
            {
              id: "activity",
              kind: "builtin:activity",
              title: "Activity",
              grid: { x: 0, y: 7, w: 12, h: 8 },
              collapsed: false,
              bindings: { runs: { source: "rpc", method: "cron.runs" } },
            },
          ],
        },
      ],
      prefs: { tabOrder: ["main"] },
    },
  };
}

/** A doc with a broken stat-card (rejectable binding) beside a healthy cron widget. */
function brokenWidgetDoc() {
  return {
    workspace: {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [
        {
          slug: "main",
          title: "Overview",
          hidden: false,
          createdBy: "system",
          widgets: [
            {
              id: "broken",
              kind: "builtin:stat-card",
              title: "Broken",
              grid: { x: 0, y: 0, w: 4, h: 2 },
              collapsed: false,
              bindings: { value: { source: "rpc", method: "dashboard.missing" } },
            },
            {
              id: "healthy",
              kind: "builtin:markdown",
              title: "Healthy",
              grid: { x: 4, y: 0, w: 8, h: 2 },
              collapsed: false,
              props: { markdown: "still here" },
            },
          ],
        },
      ],
      prefs: { tabOrder: ["main"] },
    },
  };
}

/** Mocked RPC responses backing the default-workspace data widgets. */
const DEFAULT_WORKSPACE_RPC_FIXTURES: Record<string, unknown> = {
  "usage.cost": { totals: { totalCost: 12.5, totalTokens: 1_234_000 }, days: 1 },
  "sessions.list": {
    ts: 1,
    count: 2,
    sessions: [
      {
        key: "main:1",
        displayName: "Session One",
        hasActiveRun: true,
        updatedAt: 1_700_000_000_000,
      },
      { key: "main:2", displayName: "Session Two", status: "idle", updatedAt: 1_700_000_000_000 },
    ],
  },
  "cron.list": {
    jobs: [
      {
        id: "nightly",
        name: "Nightly report",
        enabled: true,
        state: { nextRunAtMs: 1_700_000_900_000, lastRunStatus: "ok" },
      },
    ],
  },
  "cron.runs": {
    entries: [
      { ts: 1_700_000_000_000, jobName: "Nightly report", status: "ok", summary: "delivered" },
      { ts: 1_699_999_000_000, jobName: "Backup", status: "error", error: "timeout" },
    ],
  },
  "system-presence": [
    { instanceId: "gateway", mode: "gateway", platform: "darwin", lastInputSeconds: 3 },
    { host: "worker-1", mode: "node", lastInputSeconds: 400 },
  ],
};

async function rejectBinding(page: Page, method: string): Promise<void> {
  await page.evaluate((targetMethod) => {
    const gw = (
      window as unknown as {
        openclawControlUiE2eGateway?: {
          rejectDeferred: (method: string, error?: { message?: string }) => void;
        };
      }
    ).openclawControlUiE2eGateway;
    gw?.rejectDeferred(targetMethod, { message: "no such widget data" });
  }, method);
}
