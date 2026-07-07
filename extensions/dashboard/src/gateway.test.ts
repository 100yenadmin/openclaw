import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerDashboardGatewayMethods } from "./gateway.js";
import { DashboardStore } from "./store.js";

type RegisteredMethod = {
  handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
};

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-gateway-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createApi() {
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    registerGatewayMethod: vi.fn(
      (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
        methods.set(method, { handler, opts });
      },
    ),
  } as unknown as OpenClawPluginApi;
  return { api, methods };
}

async function callMethod(
  method: RegisteredMethod,
  params: Record<string, unknown>,
  broadcast = vi.fn(),
) {
  const respond = vi.fn();
  await method.handler({
    params,
    respond,
    context: { broadcast },
  } as never);
  return { broadcast, respond, response: respond.mock.calls[0] };
}

describe("dashboard gateway methods", () => {
  it("registers all L1 methods with read/write scopes", () => {
    const { api, methods } = createApi();
    registerDashboardGatewayMethods({
      api,
      store: new DashboardStore({ stateDir: "/tmp/unused" }),
    });

    expect([...methods.keys()]).toEqual([
      "dashboard.workspace.get",
      "dashboard.tab.create",
      "dashboard.tab.update",
      "dashboard.tab.delete",
      "dashboard.tab.reorder",
      "dashboard.widget.add",
      "dashboard.widget.update",
      "dashboard.widget.move",
      "dashboard.widget.remove",
      "dashboard.widget.setLayout",
      "dashboard.widget.approve",
      "dashboard.workspace.replace",
      "dashboard.workspace.undo",
      "dashboard.data.read",
      "dashboard.widget.state.get",
      "dashboard.widget.state.set",
    ]);
    const readMethods = new Set([
      "dashboard.workspace.get",
      "dashboard.data.read",
      "dashboard.widget.state.get",
    ]);
    expect(methods.get("dashboard.workspace.get")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("dashboard.data.read")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("dashboard.widget.state.get")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("dashboard.widget.state.set")?.opts).toEqual({ scope: "operator.write" });
    for (const [name, method] of methods) {
      if (readMethods.has(name)) {
        continue;
      }
      expect(method.opts).toEqual({ scope: "operator.write" });
    }
  });

  it("returns the workspace without broadcasting and broadcasts successful writes", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({ api, store: new DashboardStore({ stateDir }) });
      const broadcast = vi.fn();

      const read = await callMethod(methods.get("dashboard.workspace.get")!, {}, broadcast);
      expect(read.response?.[0]).toBe(true);
      expect(read.response?.[1]).toMatchObject({ workspaceVersion: 1 });
      expect(broadcast).not.toHaveBeenCalled();

      const created = await callMethod(
        methods.get("dashboard.tab.create")!,
        { title: "Finance Ops", actor: "agent:main" },
        broadcast,
      );

      expect(created.response?.[0]).toBe(true);
      expect(created.response?.[1]).toMatchObject({
        doc: {
          workspaceVersion: 2,
          tabs: expect.arrayContaining([expect.objectContaining({ slug: "finance-ops" })]),
        },
        workspaceVersion: 2,
      });
      expect(broadcast).toHaveBeenCalledWith("plugin.dashboard.changed", {
        workspaceVersion: 2,
        changedTabSlug: "finance-ops",
        actor: "agent:main",
      });
    });
  });

  it("rejects unknown params and bad shapes without broadcasting", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({ api, store: new DashboardStore({ stateDir }) });
      const broadcast = vi.fn();

      const response = await callMethod(
        methods.get("dashboard.tab.create")!,
        { title: "Bad", unexpected: true },
        broadcast,
      );

      expect(response.response?.[0]).toBe(false);
      expect(response.response?.[2]?.message).toContain("unexpected param");
      expect(broadcast).not.toHaveBeenCalled();
    });
  });

  it("applies widget, workspace replace, undo, and data read methods", async () => {
    await withTempStateDir(async (stateDir) => {
      const { api, methods } = createApi();
      registerDashboardGatewayMethods({
        api,
        store: new DashboardStore({ stateDir }),
      });
      const broadcast = vi.fn();

      await callMethod(
        methods.get("dashboard.tab.create")!,
        { slug: "ops", title: "Ops" },
        broadcast,
      );
      await callMethod(
        methods.get("dashboard.widget.add")!,
        {
          tab: "ops",
          widget: {
            kind: "builtin:markdown",
            title: "Notes",
            grid: { x: 0, y: 0, w: 4, h: 2 },
          },
        },
        broadcast,
      );
      const updated = await callMethod(
        methods.get("dashboard.widget.update")!,
        { tab: "ops", id: "notes", patch: { collapsed: true } },
        broadcast,
      );
      expect(
        updated.response?.[1]?.doc.tabs.find((tab: { slug: string }) => tab.slug === "ops"),
      ).toMatchObject({
        widgets: [expect.objectContaining({ id: "notes", collapsed: true })],
      });

      await callMethod(
        methods.get("dashboard.widget.move")!,
        { tab: "ops", id: "notes", grid: { x: 4, y: 0, w: 4, h: 2 } },
        broadcast,
      );
      const ambiguousMove = await callMethod(
        methods.get("dashboard.widget.move")!,
        { tab: "ops", id: "notes", grid: { x: 0, y: 0, w: 4, h: 2 }, toTab: "main" },
        broadcast,
      );
      expect(ambiguousMove.response?.[0]).toBe(false);
      expect(ambiguousMove.response?.[2]?.message).toContain("not both");
      await callMethod(
        methods.get("dashboard.widget.setLayout")!,
        { tab: "ops", layout: [{ id: "notes", grid: { x: 0, y: 3, w: 6, h: 3 } }] },
        broadcast,
      );
      await callMethod(
        methods.get("dashboard.widget.approve")!,
        { name: "custom-chart", decision: "approved" },
        broadcast,
      );
      const data = await callMethod(
        methods.get("dashboard.data.read")!,
        { binding: { source: "static", value: { ok: true } } },
        broadcast,
      );
      expect(data.response?.[1]).toEqual({ data: { ok: true } });
      const rpcData = await callMethod(
        methods.get("dashboard.data.read")!,
        { binding: { source: "rpc", method: "sessions.list" } },
        broadcast,
      );
      expect(rpcData.response?.[0]).toBe(false);
      expect(rpcData.response?.[2]).toMatchObject({ code: "binding_client_resolved" });

      const beforeReplace = await callMethod(
        methods.get("dashboard.workspace.get")!,
        {},
        broadcast,
      );
      const replacement = structuredClone(beforeReplace.response?.[1]?.doc);
      replacement.tabs = [replacement.tabs.find((tab: { slug: string }) => tab.slug === "ops")];
      replacement.prefs.tabOrder = ["ops"];
      await callMethod(
        methods.get("dashboard.workspace.replace")!,
        { doc: replacement },
        broadcast,
      );

      const undo = await callMethod(methods.get("dashboard.workspace.undo")!, {}, broadcast);
      expect(undo.response?.[0]).toBe(true);
      expect(
        undo.response?.[1]?.doc.tabs.some((tab: { slug: string }) => tab.slug === "main"),
      ).toBe(true);
      expect(broadcast).toHaveBeenCalledTimes(8);
    });
  });
});

describe("dashboard widget write-back methods", () => {
  function setup(stateDir: string) {
    const { api, methods } = createApi();
    registerDashboardGatewayMethods({ api, store: new DashboardStore({ stateDir }) });
    return methods;
  }

  it("persists a set and returns it from get; broadcasts id+version WITHOUT the blob", async () => {
    await withTempStateDir(async (stateDir) => {
      const methods = setup(stateDir);
      const broadcast = vi.fn();

      const empty = await callMethod(
        methods.get("dashboard.widget.state.get")!,
        { widgetId: "notes-1" },
        broadcast,
      );
      expect(empty.response?.[1]).toEqual({ state: null });

      const blob = { text: "hello", cursor: 5 };
      const set = await callMethod(
        methods.get("dashboard.widget.state.set")!,
        { widgetId: "notes-1", state: blob },
        broadcast,
      );
      expect(set.response?.[0]).toBe(true);
      expect(set.response?.[1]).toEqual({ widgetId: "notes-1", version: 1 });
      // Change marker carries only id + version; the blob NEVER ships in the event.
      expect(broadcast).toHaveBeenCalledWith("plugin.dashboard.widget-state.changed", {
        widgetId: "notes-1",
        version: 1,
      });
      const eventPayload = broadcast.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(eventPayload).not.toHaveProperty("state");
      expect(eventPayload).not.toHaveProperty("blob");

      const got = await callMethod(
        methods.get("dashboard.widget.state.get")!,
        { widgetId: "notes-1" },
        broadcast,
      );
      expect(got.response?.[1]).toMatchObject({ state: blob, version: 1 });

      // A second write increments the version.
      const set2 = await callMethod(
        methods.get("dashboard.widget.state.set")!,
        { widgetId: "notes-1", state: { text: "again" } },
        broadcast,
      );
      expect(set2.response?.[1]).toEqual({ widgetId: "notes-1", version: 2 });
    });
  });

  it("state files live under state/, separate from workspace.json", async () => {
    await withTempStateDir(async (stateDir) => {
      const methods = setup(stateDir);
      await callMethod(methods.get("dashboard.widget.state.set")!, {
        widgetId: "notes-1",
        state: { a: 1 },
      });
      const stateFile = path.join(stateDir, "dashboard", "state", "notes-1.json");
      expect(fsSync.existsSync(stateFile)).toBe(true);
      // Separation: the blob lives in state/, never in the workspace document.
      // A state.set doesn't create or write workspace.json at all, so the file is
      // simply absent here — and if a prior workspace op ever created it, it must
      // not carry the widget's blob either.
      const workspacePath = path.join(stateDir, "dashboard", "workspace.json");
      const workspaceRaw = fsSync.existsSync(workspacePath)
        ? await fs.readFile(workspacePath, "utf8")
        : "";
      expect(workspaceRaw).not.toContain('"a":1');
    });
  });

  it("rejects an oversize blob WHOLE (nothing written)", async () => {
    await withTempStateDir(async (stateDir) => {
      const methods = setup(stateDir);
      const broadcast = vi.fn();

      const big = "x".repeat(70 * 1024);
      const rejected = await callMethod(
        methods.get("dashboard.widget.state.set")!,
        { widgetId: "notes-1", state: { text: big } },
        broadcast,
      );
      expect(rejected.response?.[0]).toBe(false);
      expect(rejected.response?.[2]?.message).toContain("64 KB");
      // No broadcast on failure, and nothing on disk for this widget.
      expect(broadcast).not.toHaveBeenCalled();
      const stateFile = path.join(stateDir, "dashboard", "state", "notes-1.json");
      expect(fsSync.existsSync(stateFile)).toBe(false);
    });
  });

  it("does not partially overwrite a prior value on an oversize write", async () => {
    await withTempStateDir(async (stateDir) => {
      const methods = setup(stateDir);
      await callMethod(methods.get("dashboard.widget.state.set")!, {
        widgetId: "notes-1",
        state: { ok: true },
      });
      const rejected = await callMethod(methods.get("dashboard.widget.state.set")!, {
        widgetId: "notes-1",
        state: { text: "x".repeat(70 * 1024) },
      });
      expect(rejected.response?.[0]).toBe(false);
      // The prior value survives intact (atomic replace never touched the file).
      const got = await callMethod(methods.get("dashboard.widget.state.get")!, {
        widgetId: "notes-1",
      });
      expect(got.response?.[1]).toMatchObject({ state: { ok: true }, version: 1 });
    });
  });

  it("rejects widget ids that traverse or use an invalid charset", async () => {
    await withTempStateDir(async (stateDir) => {
      const methods = setup(stateDir);
      for (const widgetId of ["../evil", "a/b", "foo.json", "..", "with space", "x".repeat(49)]) {
        const set = await callMethod(methods.get("dashboard.widget.state.set")!, {
          widgetId,
          state: { x: 1 },
        });
        expect(set.response?.[0]).toBe(false);
        const get = await callMethod(methods.get("dashboard.widget.state.get")!, { widgetId });
        expect(get.response?.[0]).toBe(false);
      }
      // No files escaped the state dir.
      const escaped = path.join(stateDir, "dashboard", "evil.json");
      expect(fsSync.existsSync(escaped)).toBe(false);
    });
  });

  it("rejects unknown params and a missing state field", async () => {
    await withTempStateDir(async (stateDir) => {
      const methods = setup(stateDir);
      const unknown = await callMethod(methods.get("dashboard.widget.state.set")!, {
        widgetId: "notes-1",
        state: {},
        extra: true,
      });
      expect(unknown.response?.[0]).toBe(false);
      expect(unknown.response?.[2]?.message).toContain("unexpected param");

      const missing = await callMethod(methods.get("dashboard.widget.state.set")!, {
        widgetId: "notes-1",
      });
      expect(missing.response?.[0]).toBe(false);
      expect(missing.response?.[2]?.message).toContain("state is required");
    });
  });
});
