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
import type { DashboardWidget } from "../types.ts";

/** Operator decision on a pending approval, in the approvals widget's own terms. */
export type ApprovalDecision = "approve" | "reject";

/** One pending approval row rendered by the `approvals` builtin. */
export type PendingApprovalItem = {
  /** Stable resolve key (the custom-widget name for `widget` approvals). */
  id: string;
  /** Approval class; only `widget` is reachable from a builtin today (see approvals.ts). */
  kind: "widget";
  /** Human label for the pending item. */
  title: string;
  /** Requesting agent id when the item carries agent provenance, else null. */
  requestedBy: string | null;
};

/**
 * Pending-approval data + resolver for the `approvals` builtin. Supplied via
 * context (like `embed`) rather than the primary binding, because the pending
 * queue is in-memory workspace state, not an allowlisted RPC read. The view wires
 * `onDecide` through the same client path the custom-widget pending card uses.
 */
export type ApprovalsWidgetSource = {
  pending: PendingApprovalItem[];
  onDecide: (item: PendingApprovalItem, decision: ApprovalDecision) => void;
};

/** Ambient context a builtin may need beyond its own binding value. */
export type BuiltinWidgetContext = {
  /** Control UI embed policy — only the iframe-embed widget consumes it. */
  embed: Pick<ApplicationConfig, "embedSandboxMode" | "allowExternalEmbedUrls">;
  /** Pending-approvals slice — only the `approvals` widget consumes it. */
  approvals?: ApprovalsWidgetSource;
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
