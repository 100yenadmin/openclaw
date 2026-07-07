// builtin:action-form — a small operator-authored form that dispatches a prompt
// (00 §Living Answers, #101821). The `template` and `fields` are authored at write
// time and schema-validated (extensions/dashboard schema `validateActionFormProps`);
// only the field VALUES vary per click.
//
// SECURITY MODEL (normative):
// - Interpolation is a SINGLE pass over the authored template (`buildActionFormPrompt`):
//   each `{slot}` is replaced by the typed, length-capped value of the declared field
//   of that name. Because we scan the TEMPLATE (not the values) and use a function
//   replacer, an injected `{evil}` inside a field VALUE is inserted literally and is
//   NEVER re-scanned — no nested/double expansion.
// - Every `{slot}` names a declared field (the schema rejects unknown slots at write
//   time); an undeclared slot reaching here is left literal, never resolved.
// - Submission goes through `ctx.dispatchPrompt`, which is the SAME confirm +
//   rate-limit gate the custom-widget bridge uses (`dispatchRateLimitedPrompt`). The
//   builtin gains no new dispatch privilege.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { DashboardWidget } from "../types.ts";
import { isRecord, widgetProps, type BuiltinWidgetContext } from "./types.ts";

export type ActionFormFieldType = "text" | "number" | "select";

export type ActionFormField = {
  name: string;
  label: string;
  type: ActionFormFieldType;
  options?: string[];
  maxLength?: number;
};

export type ActionFormModel = {
  template: string;
  fields: ActionFormField[];
  buttonLabel: string | null;
};

/** Default per-field value cap when a field declares no `maxLength`. */
export const ACTION_FORM_DEFAULT_MAX_LENGTH = 200;

// Same alphabet as the write-time slot check (extensions/dashboard schema) — keep in sync.
const SLOT_PATTERN = /\{([A-Za-z0-9_]+)\}/g;
const FIELD_TYPES = new Set<ActionFormFieldType>(["text", "number", "select"]);

/** Defensively parse one field descriptor from untyped props, or null when malformed. */
function mapField(value: unknown): ActionFormField | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, label, type } = value;
  if (typeof name !== "string" || !name || typeof label !== "string" || !label) {
    return null;
  }
  if (typeof type !== "string" || !FIELD_TYPES.has(type as ActionFormFieldType)) {
    return null;
  }
  const options =
    type === "select" && Array.isArray(value.options)
      ? value.options.filter((option): option is string => typeof option === "string")
      : undefined;
  if (type === "select" && (!options || options.length === 0)) {
    return null;
  }
  const maxLength =
    typeof value.maxLength === "number" && Number.isInteger(value.maxLength) && value.maxLength > 0
      ? value.maxLength
      : undefined;
  return {
    name,
    label,
    type: type as ActionFormFieldType,
    ...(options ? { options } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
  };
}

/** Read the action-form view model from a widget's props (defensive; schema is the gate). */
export function mapActionForm(widget: DashboardWidget): ActionFormModel {
  const props = widgetProps(widget);
  const template = typeof props.template === "string" ? props.template : "";
  const fields = Array.isArray(props.fields)
    ? props.fields.map(mapField).filter((field): field is ActionFormField => field !== null)
    : [];
  const buttonLabel = typeof props.buttonLabel === "string" ? props.buttonLabel : null;
  return { template, fields, buttonLabel };
}

/** Type + length cap for one field's raw string value. Non-numeric numbers and out-of-set selects collapse to "". */
export function coerceFieldValue(field: ActionFormField, raw: string): string {
  const cap =
    field.maxLength && field.maxLength > 0 ? field.maxLength : ACTION_FORM_DEFAULT_MAX_LENGTH;
  if (field.type === "number") {
    const trimmed = raw.trim();
    return trimmed && Number.isFinite(Number(trimmed)) ? trimmed.slice(0, cap) : "";
  }
  if (field.type === "select") {
    return field.options?.includes(raw) ? raw : "";
  }
  return raw.slice(0, cap);
}

/**
 * Interpolate declared field values into the authored template in a SINGLE pass.
 * Only `{slot}` tokens that name a declared field are replaced; the replacement
 * text is inserted literally (function replacer) and never re-scanned, so a value
 * containing `{...}` cannot expand. Unknown slots are left verbatim.
 */
export function buildActionFormPrompt(
  model: ActionFormModel,
  values: Record<string, string>,
): string {
  const byName = new Map(model.fields.map((field) => [field.name, field]));
  return model.template.replace(SLOT_PATTERN, (match, name: string) => {
    const field = byName.get(name);
    if (!field) {
      return match;
    }
    return coerceFieldValue(field, values[name] ?? "");
  });
}

function renderField(field: ActionFormField): TemplateResult {
  const control =
    field.type === "select"
      ? html`<select class="dashboard-action-form__control" name=${field.name}>
          ${(field.options ?? []).map((option) => html`<option value=${option}>${option}</option>`)}
        </select>`
      : html`<input
          class="dashboard-action-form__control"
          type=${field.type === "number" ? "number" : "text"}
          name=${field.name}
          maxlength=${field.maxLength ?? ACTION_FORM_DEFAULT_MAX_LENGTH}
        />`;
  return html`<label class="dashboard-action-form__field">
    <span class="dashboard-action-form__label">${field.label}</span>
    ${control}
  </label>`;
}

/** Renders the action-form builtin. Submit interpolates + dispatches through the shared gate. */
export function renderActionForm(
  widget: DashboardWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const model = mapActionForm(widget);
  if (model.fields.length === 0 || !model.template) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.actionForm.empty")}
    </div>`;
  }
  const onSubmit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values: Record<string, string> = {};
    for (const field of model.fields) {
      const control = form.elements.namedItem(field.name);
      values[field.name] = control && "value" in control ? (control as HTMLInputElement).value : "";
    }
    const text = buildActionFormPrompt(model, values);
    if (!text.trim() || !ctx.dispatchPrompt) {
      return;
    }
    // widgetKey namespaces the shared rate budget by this widget's stable id.
    void ctx
      .dispatchPrompt({ widgetKey: `builtin:action-form:${widget.id}`, text })
      .then((outcome) => {
        if (outcome === "sent") {
          form.reset();
        }
      })
      .catch(() => {
        // Dispatch failures surface via the shared toast; the form stays usable.
      });
  };
  return html`
    <form class="dashboard-action-form" data-test-id="dashboard-action-form" @submit=${onSubmit}>
      ${model.fields.map(renderField)}
      <button class="btn btn--small btn--primary dashboard-action-form__submit" type="submit">
        ${model.buttonLabel ?? t("dashboard.widget.actionForm.submit")}
      </button>
    </form>
    ${ctx.dispatchPrompt
      ? nothing
      : html`<span hidden data-test-id="dashboard-action-form-inert"></span>`}
  `;
}
