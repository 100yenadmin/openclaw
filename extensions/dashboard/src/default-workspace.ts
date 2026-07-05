import type { WorkspaceDoc } from "./schema.js";

export const DEFAULT_DASHBOARD_WORKSPACE: WorkspaceDoc = {
  schemaVersion: 1,
  workspaceVersion: 1,
  tabs: [
    {
      slug: "main",
      title: "Overview",
      icon: "layoutDashboard",
      hidden: false,
      createdBy: "system",
      widgets: [
        {
          id: "cost-today",
          kind: "builtin:stat-card",
          title: "Cost Today",
          grid: { x: 0, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          bindings: {
            value: { source: "rpc", method: "usage.cost" },
          },
          props: { metric: "todayCost", format: "usd" },
        },
        {
          id: "tokens-today",
          kind: "builtin:stat-card",
          title: "Tokens Today",
          grid: { x: 4, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          bindings: {
            value: { source: "rpc", method: "usage.status" },
          },
          props: { metric: "todayTokens", format: "integer" },
        },
        {
          id: "instances-health",
          kind: "builtin:instances",
          title: "Instances",
          grid: { x: 8, y: 0, w: 4, h: 2 },
          collapsed: false,
          hidden: false,
          bindings: {
            nodes: { source: "rpc", method: "node.list" },
            health: { source: "rpc", method: "health" },
          },
        },
        {
          id: "sessions",
          kind: "builtin:sessions",
          title: "Sessions",
          grid: { x: 0, y: 2, w: 6, h: 5 },
          collapsed: false,
          hidden: false,
          bindings: {
            sessions: { source: "rpc", method: "sessions.list" },
          },
        },
        {
          id: "cron",
          kind: "builtin:cron",
          title: "Cron",
          grid: { x: 6, y: 2, w: 6, h: 5 },
          collapsed: false,
          hidden: false,
          bindings: {
            jobs: { source: "rpc", method: "cron.list" },
            status: { source: "rpc", method: "cron.status" },
          },
        },
        {
          id: "activity",
          kind: "builtin:activity",
          title: "Activity",
          grid: { x: 0, y: 7, w: 12, h: 8 },
          collapsed: false,
          hidden: false,
          bindings: {
            sessions: { source: "rpc", method: "sessions.usage.logs" },
          },
        },
      ],
    },
  ],
  widgetsRegistry: {},
  prefs: { tabOrder: ["main"] },
};
