import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerDashboardGatewayMethods } from "./src/gateway.js";
import { DashboardStore } from "./src/store.js";

export default definePluginEntry({
  id: "dashboard",
  name: "Dashboard",
  description: "Composable dashboard workspace document and control-plane RPC backend.",
  register(api) {
    const store = new DashboardStore();
    registerDashboardGatewayMethods({ api, store });

    // Declares the Workspaces tab; the Control UI renders its bundled view
    // (BUNDLED_TAB_VIEWS "dashboard/workspaces") only while this plugin is
    // active, so no core code references the plugin id.
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workspaces",
      label: "Workspaces",
      description: "Composable dashboards you and your agents build together.",
      icon: "puzzle",
      group: "control",
      order: -10,
      requiredScopes: ["operator.read"],
    });

    // L2/L5 wire tools, CLI, and HTTP routes through this same store
    // instance so every caller shares one validated writer.
  },
});
