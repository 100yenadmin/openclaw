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
    // L2/L3/L5 wire tools, CLI, Control UI descriptors, and HTTP routes through
    // this same store instance so every caller shares one validated writer.
  },
});
