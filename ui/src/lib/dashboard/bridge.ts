// Parent side of the custom-widget postMessage bridge (00 §6, spec-50 §Bridge).
//
// DOM-free and unit-testable: the browser host (`dashboard-custom-widget.ts`)
// wires a real iframe + window listener to `createWidgetBridge`, but every
// security decision — accept filter, manifest gating, capability checks, rate
// limiting, timeouts — lives here so it can be tested without a DOM.
//
// SECURITY MODEL (normative):
// - The child's origin is opaque (`null`) because the iframe is sandboxed without
//   `allow-same-origin`. NEVER compare origin strings; the accept filter is the
//   IDENTITY check `event.source === iframe.contentWindow`, wired by the host.
// - A widget may only request bindings declared in the manifest the operator
//   approved. Undeclared bindingId → `dashboard:error {code:"binding_denied"}`.
// - `sendPrompt` requires the manifest `prompt:send` capability AND an operator
//   confirm per invocation AND a rate limit (1 in-flight, 10/min).
// - Parent→child posts always use targetOrigin "*" (opaque origin), carrying only
//   binding data / theme tokens the widget is entitled to — never secrets.

import type { WidgetManifestView } from "./types.ts";

export const BRIDGE_ENVELOPE_VERSION = 1;

/** child→parent message types. */
export type WidgetInboundType =
  | "dashboard:ready"
  | "dashboard:getData"
  | "dashboard:getTheme"
  | "dashboard:sendPrompt";

/** parent→child message types. */
export type WidgetOutboundType =
  | "dashboard:data"
  | "dashboard:push"
  | "dashboard:theme"
  | "dashboard:error";

export type WidgetErrorCode =
  | "binding_denied"
  | "capability_denied"
  | "rate_limited"
  | "prompt_declined"
  | "timeout"
  | "resolve_failed"
  | "malformed";

export type WidgetOutboundMessage =
  | { v: 1; type: "dashboard:data"; requestId: string; bindingId: string; data: unknown }
  | { v: 1; type: "dashboard:push"; bindingId: string; data: unknown }
  | { v: 1; type: "dashboard:theme"; requestId: string; tokens: Record<string, string> }
  | { v: 1; type: "dashboard:error"; requestId?: string; code: WidgetErrorCode; message: string };

/** Injected side effects — real implementations live in the browser host. */
export type WidgetBridgeDeps = {
  manifest: WidgetManifestView;
  /** Resolve a manifest-declared binding by id (file/static via data.read, rpc via gateway). */
  resolveBinding: (bindingId: string) => Promise<unknown>;
  /** Current theme tokens (CSS custom-property values from the document root). */
  resolveTheme: () => Record<string, string>;
  /** Operator confirm dialog quoting the exact prompt text; resolves true to send. */
  confirmPrompt: (text: string) => Promise<boolean>;
  /** Dispatch the prompt through the existing chat-send path. */
  sendPrompt: (text: string) => Promise<void>;
  /** Post a message to the child (host wires targetOrigin "*"). */
  post: (message: WidgetOutboundMessage) => void;
  /** getData answer deadline; posts a timeout error if the resolver overruns. Default 10s. */
  getDataTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type WidgetBridge = {
  /** Handle one already-source-verified inbound message. Returns true if accepted. */
  handleMessage: (data: unknown) => boolean;
  /** Push fresh data for a declared binding to the child (broadcast-driven). */
  push: (bindingId: string) => Promise<void>;
  /** Count of messages dropped by the accept filter (well-formedness). For tests. */
  readonly droppedCount: number;
  dispose: () => void;
};

const DEFAULT_GET_DATA_TIMEOUT_MS = 10_000;
const PROMPT_RATE_WINDOW_MS = 60_000;
const PROMPT_RATE_MAX = 10;

const INBOUND_TYPES = new Set<WidgetInboundType>([
  "dashboard:ready",
  "dashboard:getData",
  "dashboard:getTheme",
  "dashboard:sendPrompt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Well-formedness filter: a valid inbound message is an object with `v === 1` and
 * a known `type`. Anything else is dropped silently (counted for tests). This runs
 * AFTER the host's `event.source === iframe.contentWindow` identity check.
 */
export function isWellFormedInbound(
  data: unknown,
): data is { v: 1; type: WidgetInboundType } & Record<string, unknown> {
  return (
    isRecord(data) &&
    data.v === BRIDGE_ENVELOPE_VERSION &&
    typeof data.type === "string" &&
    INBOUND_TYPES.has(data.type as WidgetInboundType)
  );
}

/** Creates the parent-side bridge for one approved custom widget. */
export function createWidgetBridge(deps: WidgetBridgeDeps): WidgetBridge {
  const now = deps.now ?? (() => Date.now());
  const getDataTimeoutMs = deps.getDataTimeoutMs ?? DEFAULT_GET_DATA_TIMEOUT_MS;
  const declaredBindingIds = new Set(deps.manifest.bindingIds);
  const capabilities = new Set(deps.manifest.capabilities);
  let dropped = 0;
  let disposed = false;
  let promptInFlight = false;
  let promptTimestamps: number[] = [];
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function error(code: WidgetErrorCode, message: string, requestId?: string): void {
    deps.post({
      v: 1,
      type: "dashboard:error",
      ...(requestId !== undefined ? { requestId } : {}),
      code,
      message,
    });
  }

  async function handleGetData(requestId: string, bindingId: string): Promise<void> {
    if (!declaredBindingIds.has(bindingId)) {
      // A widget cannot request a binding the operator did not approve.
      error("binding_denied", `binding not declared in manifest: ${bindingId}`, requestId);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || disposed) {
        return;
      }
      settled = true;
      pendingTimers.delete(timer);
      error("timeout", "binding resolution timed out", requestId);
    }, getDataTimeoutMs);
    pendingTimers.add(timer);
    try {
      const data = await deps.resolveBinding(bindingId);
      if (settled || disposed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingTimers.delete(timer);
      deps.post({ v: 1, type: "dashboard:data", requestId, bindingId, data });
    } catch (err) {
      if (settled || disposed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingTimers.delete(timer);
      error("resolve_failed", err instanceof Error ? err.message : String(err), requestId);
    }
  }

  function handleGetTheme(requestId: string): void {
    deps.post({ v: 1, type: "dashboard:theme", requestId, tokens: deps.resolveTheme() });
  }

  async function handleSendPrompt(requestId: string, text: string): Promise<void> {
    if (!capabilities.has("prompt:send")) {
      // Denied WITHOUT showing a dialog — the capability gate is first.
      error("capability_denied", "widget lacks the prompt:send capability", requestId);
      return;
    }
    // Rate limit: at most one in-flight prompt and 10 per rolling minute.
    const cutoff = now() - PROMPT_RATE_WINDOW_MS;
    promptTimestamps = promptTimestamps.filter((ts) => ts > cutoff);
    if (promptInFlight || promptTimestamps.length >= PROMPT_RATE_MAX) {
      error("rate_limited", "prompt send rate limit exceeded", requestId);
      return;
    }
    promptInFlight = true;
    try {
      const confirmed = await deps.confirmPrompt(text);
      if (disposed) {
        return;
      }
      if (!confirmed) {
        // Deny path sends NOTHING.
        error("prompt_declined", "operator declined the prompt", requestId);
        return;
      }
      promptTimestamps.push(now());
      await deps.sendPrompt(text);
    } catch (err) {
      if (!disposed) {
        error("resolve_failed", err instanceof Error ? err.message : String(err), requestId);
      }
    } finally {
      promptInFlight = false;
    }
  }

  function handleMessage(data: unknown): boolean {
    if (disposed) {
      return false;
    }
    if (!isWellFormedInbound(data)) {
      dropped += 1;
      return false;
    }
    switch (data.type) {
      case "dashboard:ready":
        return true;
      case "dashboard:getData": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const bindingId = typeof data.bindingId === "string" ? data.bindingId : null;
        if (requestId === null || bindingId === null) {
          dropped += 1;
          return false;
        }
        void handleGetData(requestId, bindingId);
        return true;
      }
      case "dashboard:getTheme": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        if (requestId === null) {
          dropped += 1;
          return false;
        }
        handleGetTheme(requestId);
        return true;
      }
      case "dashboard:sendPrompt": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const text = typeof data.text === "string" ? data.text : null;
        if (requestId === null || text === null || !text.trim()) {
          dropped += 1;
          return false;
        }
        void handleSendPrompt(requestId, text);
        return true;
      }
      default:
        dropped += 1;
        return false;
    }
  }

  async function push(bindingId: string): Promise<void> {
    if (disposed || !declaredBindingIds.has(bindingId)) {
      return;
    }
    try {
      const data = await deps.resolveBinding(bindingId);
      if (!disposed) {
        deps.post({ v: 1, type: "dashboard:push", bindingId, data });
      }
    } catch {
      // Push is best-effort; a failed refresh keeps the last value on the child.
    }
  }

  return {
    handleMessage,
    push,
    get droppedCount() {
      return dropped;
    },
    dispose() {
      disposed = true;
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
    },
  };
}
