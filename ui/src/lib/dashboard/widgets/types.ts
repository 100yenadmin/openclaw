// Contract for the L4 builtin widget library. Each builtin is a pure render
// function keyed by its kind (`builtin:<name>`); the widget cell dispatches
// through the registry (`./index.ts`). Data-shape mapping lives in exported,
// separately-unit-tested `map*` helpers per widget so the RPC payload → view
// model transform is verifiable without a DOM.
//
// Renderers NEVER fetch: they receive the already-resolved primary binding
// value (the L3 view resolves the first declared binding on the page's gateway
// client) plus the widget's `props`. A binding error is surfaced by the cell's
// error boundary before a renderer runs, so renderers only see values.

import type { TemplateResult } from "lit";
import type { ApplicationConfig } from "../../../app/config.ts";
import type { PromptDispatchOutcome } from "../bridge.ts";
import type { DashboardWidget } from "../types.ts";

/** Ambient context a builtin may need beyond its own binding value. */
export type BuiltinWidgetContext = {
  /** Control UI embed policy — only the iframe-embed widget consumes it. */
  embed: Pick<ApplicationConfig, "embedSandboxMode" | "allowExternalEmbedUrls">;
  /**
   * Confirm + rate-limited prompt dispatch — only the action-form widget consumes
   * it. Wired (in dashboard-view) to the SAME shared gate the custom-widget bridge
   * uses (`dispatchRateLimitedPrompt`), so builtins gain no new dispatch privilege.
   * Absent in isolated unit renders; the form then treats submit as inert.
   */
  dispatchPrompt?: (params: { widgetKey: string; text: string }) => Promise<PromptDispatchOutcome>;
};

/** A builtin widget renderer: pure, side-effect-free, throws only on real bugs. */
export type BuiltinWidgetRenderer = (
  widget: DashboardWidget,
  value: unknown,
  ctx: BuiltinWidgetContext,
) => TemplateResult;

export function widgetProps(widget: DashboardWidget): Record<string, unknown> {
  return widget.props ?? {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a possibly-string numeric field to a finite number, else undefined. */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
