// builtin:agent-status — a compact per-agent/session status list (busy vs idle,
// current objective, and run progress if present). Thin re-implementation over
// the SAME `sessions.list` data the `sessions` builtin maps (it exposes
// `hasActiveRun` / `status` / `goal`). Binding value shape:
// `{ sessions: GatewaySessionRow[] }` or a bare row array.

import { html, nothing, type TemplateResult } from "lit";
import type { SessionRunStatus } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { clampText } from "../../format.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import type { DashboardWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 8;

export type AgentStatusRowModel = {
  key: string;
  label: string;
  active: boolean;
  task: string | null;
  /** Fractional run progress in [0,1], derived from goal token budget, if present. */
  progress: number | null;
};

export type AgentStatusModel = {
  rows: AgentStatusRowModel[];
  activeCount: number;
  total: number;
};

function rowLabel(row: Record<string, unknown>, key: string): string {
  const display = row.displayName ?? row.label ?? row.subject ?? row.channel;
  return typeof display === "string" && display.trim() ? display : key;
}

/** Current task/objective for the row: the active goal objective, if any. */
function rowTask(row: Record<string, unknown>): string | null {
  const goal = isRecord(row.goal) ? row.goal : undefined;
  const objective = goal && typeof goal.objective === "string" ? goal.objective.trim() : "";
  return objective ? clampText(objective, 100) : null;
}

/** Fractional run progress from a goal's token budget, clamped to [0,1]. */
function rowProgress(row: Record<string, unknown>): number | null {
  const goal = isRecord(row.goal) ? row.goal : undefined;
  if (!goal) {
    return null;
  }
  const used = toFiniteNumber(goal.tokensUsed);
  const budget = toFiniteNumber(goal.tokenBudget);
  if (used === undefined || budget === undefined || budget <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, used / budget));
}

export function mapAgentStatus(widget: DashboardWidget, value: unknown): AgentStatusModel {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const mapped = records
    .map((row) => {
      const key = typeof row.key === "string" ? row.key : "";
      return {
        key,
        label: rowLabel(row, key),
        active: isSessionRunActive({
          hasActiveRun: typeof row.hasActiveRun === "boolean" ? row.hasActiveRun : undefined,
          status: typeof row.status === "string" ? (row.status as SessionRunStatus) : undefined,
        }),
        task: rowTask(row),
        progress: rowProgress(row),
      };
    })
    .filter((row) => row.key);
  const activeCount = mapped.filter((row) => row.active).length;
  return { rows: mapped.slice(0, limit), activeCount, total: mapped.length };
}

export function renderAgentStatus(widget: DashboardWidget, value: unknown): TemplateResult {
  const model = mapAgentStatus(widget, value);
  if (model.rows.length === 0) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.agentStatus.empty")}
    </div>`;
  }
  return html`
    <ul class="dashboard-list dashboard-agent-status" data-test-id="dashboard-agent-status">
      ${model.rows.map(
        (row) => html`
          <li class="dashboard-list__row">
            <span
              class="dashboard-dot ${row.active ? "dashboard-dot--live" : ""}"
              aria-hidden="true"
            ></span>
            <span class="dashboard-list__label">${row.label}</span>
            <span
              class="dashboard-badge ${row.active
                ? "dashboard-badge--ok"
                : "dashboard-badge--muted"}"
            >
              ${row.active
                ? t("dashboard.widget.agentStatus.busy")
                : t("dashboard.widget.agentStatus.idle")}
            </span>
            ${row.task ? html`<span class="dashboard-list__meta">${row.task}</span>` : nothing}
            ${row.progress !== null
              ? html`<span class="dashboard-list__meta"
                  >${t("dashboard.widget.agentStatus.progress", {
                    percent: String(Math.round(row.progress * 100)),
                  })}</span
                >`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
