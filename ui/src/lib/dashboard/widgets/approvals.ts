// builtin:approvals — a pending-approval queue with per-row Approve/Deny actions.
//
// Data source & gap note: OpenClaw's exec/shell and plugin/tool approval queues
// are served by operator-scoped RPCs (`exec.approval.list` / `exec.approval.resolve`,
// `plugin.approval.list` / `plugin.approval.resolve`) that are NOT in the read-only
// dashboard binding allowlist (extensions/dashboard/src/binding-contract.ts), so a
// pure builtin cannot bind to them without widening that operator surface. This
// builtin therefore reuses the reachable, existing approvals infrastructure: the
// dashboard's own widget-approval registry (#101098) — pending `custom:` widgets —
// and resolves each decision through the SAME `dashboard.widget.approve` path the
// custom-widget pending card uses (lib/dashboard/index.ts `approveWidget`).
//
// Unlike the data builtins, the pending list + resolver arrive via `ctx.approvals`
// (mirroring iframe-embed's `ctx.embed`), not the primary binding `value`, because
// the queue is in-memory workspace state rather than an allowlisted RPC read.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { dashboardAgentProvenance } from "../types.ts";
import type { DashboardWidget, DashboardWorkspace } from "../types.ts";
import {
  isRecord,
  toFiniteNumber,
  widgetProps,
  type ApprovalDecision,
  type ApprovalsWidgetSource,
  type BuiltinWidgetContext,
  type PendingApprovalItem,
} from "./types.ts";

const DEFAULT_LIMIT = 8;

export type ApprovalsModel = {
  items: PendingApprovalItem[];
  total: number;
};

/** Map an approvals widget's UI decision to the registry decision `approveWidget` takes. */
export function toWidgetApprovalDecision(decision: ApprovalDecision): "approved" | "rejected" {
  return decision === "approve" ? "approved" : "rejected";
}

/**
 * Derive the pending-widget-approval source from the workspace registry, wiring
 * each decision through `resolve` (the view passes `approveWidget`). Pure so the
 * view and tests build the identical source.
 */
export function buildWidgetApprovalsSource(
  workspace: DashboardWorkspace,
  resolve: (name: string, decision: "approved" | "rejected") => void,
): ApprovalsWidgetSource {
  const pending: PendingApprovalItem[] = Object.entries(workspace.widgetsRegistry)
    .filter(([, entry]) => entry.status === "pending")
    .map(([name, entry]) => ({
      id: name,
      kind: "widget" as const,
      title: name,
      requestedBy: dashboardAgentProvenance(entry.createdBy),
    }));
  return {
    pending,
    onDecide: (item, decision) => resolve(item.id, toWidgetApprovalDecision(decision)),
  };
}

export function mapApprovals(
  widget: DashboardWidget,
  source: ApprovalsWidgetSource | undefined,
): ApprovalsModel {
  const pending = source?.pending.filter((item) => isRecord(item) && item.id) ?? [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  return { items: pending.slice(0, limit), total: pending.length };
}

export function renderApprovals(
  widget: DashboardWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const source = ctx.approvals;
  const model = mapApprovals(widget, source);
  if (model.items.length === 0) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.approvals.empty")}
    </div>`;
  }
  return html`
    <ul class="dashboard-list dashboard-approvals" data-test-id="dashboard-approvals">
      ${model.items.map(
        (item) => html`
          <li class="dashboard-list__row">
            <span class="dashboard-badge dashboard-badge--muted"
              >${t(`dashboard.widget.approvals.kind.${item.kind}`)}</span
            >
            <span class="dashboard-list__label">${item.title}</span>
            ${item.requestedBy
              ? html`<span class="dashboard-list__meta"
                  >${t("dashboard.widget.approvals.requestedBy", { agent: item.requestedBy })}</span
                >`
              : nothing}
            <span class="dashboard-approvals__actions">
              <button
                class="btn btn--small btn--primary"
                type="button"
                data-test-id="dashboard-approvals-approve"
                @click=${() => source?.onDecide(item, "approve")}
              >
                ${t("dashboard.widget.approvals.approve")}
              </button>
              <button
                class="btn btn--small"
                type="button"
                data-test-id="dashboard-approvals-deny"
                @click=${() => source?.onDecide(item, "reject")}
              >
                ${t("dashboard.widget.approvals.deny")}
              </button>
            </span>
          </li>
        `,
      )}
    </ul>
  `;
}
