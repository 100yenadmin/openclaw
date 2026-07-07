import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_WORKSPACE } from "./default-workspace.js";
import { validateWorkspaceDoc, type WorkspaceDoc } from "./schema.js";

function validDoc(): WorkspaceDoc {
  return structuredClone(DEFAULT_DASHBOARD_WORKSPACE);
}

function expectInvalid(mutator: (doc: WorkspaceDoc) => void, message: string) {
  const doc = validDoc();
  mutator(doc);

  expect(() => validateWorkspaceDoc(doc)).toThrow(message);
}

describe("dashboard workspace schema", () => {
  it("accepts the default workspace seed", () => {
    expect(validateWorkspaceDoc(validDoc())).toEqual(validDoc());
  });

  it("rejects invalid tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.slug = "Bad Slug";
    }, "tabs[0].slug");
  });

  it("rejects duplicate tab slugs", () => {
    expectInvalid((doc) => {
      doc.tabs.push({ ...structuredClone(doc.tabs[0]!), title: "Duplicate" });
    }, "duplicate tab slug");
  });

  it("rejects widget grid overflow", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.grid = { x: 10, y: 0, w: 3, h: 2 };
    }, "x + w");
  });

  it("rejects invalid widget kinds", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.kind = "builtin:unknown";
    }, "widgets[0].kind");
  });

  it("rejects invalid binding unions", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        bad: { source: "command", value: "date" } as never,
      };
    }, "bindings.bad.source");
  });

  it("rejects non-allowlisted rpc binding methods at write time", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.bindings = {
        sessions: { source: "rpc", method: "config.get" },
      };
    }, "bindings.sessions.method is not allowlisted");
  });

  it("rejects tabs and widgets over the caps", () => {
    expectInvalid((doc) => {
      doc.tabs = Array.from({ length: 33 }, (_, index) => ({
        ...structuredClone(doc.tabs[0]!),
        slug: `tab-${index}`,
      }));
    }, "tabs must contain at most 32 entries");

    expectInvalid((doc) => {
      doc.tabs[0]!.widgets = Array.from({ length: 25 }, (_, index) => ({
        ...structuredClone(doc.tabs[0]!.widgets[0]!),
        id: `w_${index}`,
      }));
    }, "widgets must contain at most 24 entries");
  });

  it("rejects invalid createdBy provenance", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.createdBy = "robot" as never;
    }, "createdBy");
  });

  it("accepts a widget with a valid ISO ephemeral expiry", () => {
    const doc = validDoc();
    doc.tabs[0]!.widgets[0]!.ephemeral = { expiresAt: "2026-07-09T12:00:00.000Z" };
    const validated = validateWorkspaceDoc(doc);
    expect(validated.tabs[0]!.widgets[0]!.ephemeral).toEqual({
      expiresAt: "2026-07-09T12:00:00.000Z",
    });
  });

  it("rejects a non-ISO ephemeral expiry", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.ephemeral = { expiresAt: "next tuesday" };
    }, "expiresAt must be an ISO 8601 timestamp");
  });

  it("rejects an ephemeral expiry without a timezone", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.ephemeral = { expiresAt: "2026-07-09T12:00:00" };
    }, "expiresAt must be an ISO 8601 timestamp");
  });

  it("rejects unknown keys inside ephemeral", () => {
    expectInvalid((doc) => {
      doc.tabs[0]!.widgets[0]!.ephemeral = {
        expiresAt: "2026-07-09T12:00:00Z",
        ttl: 3600,
      } as never;
    }, "ephemeral.ttl is not allowed");
  });
});

describe("builtin:action-form props", () => {
  function withActionForm(props: unknown): WorkspaceDoc {
    const doc = validDoc();
    doc.tabs[0]!.widgets.push({
      id: "action-1",
      kind: "builtin:action-form",
      grid: { x: 0, y: 30, w: 4, h: 3 },
      collapsed: false,
      hidden: false,
      props: props as never,
    });
    return doc;
  }

  const validProps = () => ({
    template: "Deploy {service} to {env}",
    fields: [
      { name: "service", label: "Service", type: "text", maxLength: 40 },
      { name: "env", label: "Environment", type: "select", options: ["staging", "prod"] },
    ],
    buttonLabel: "Deploy",
  });

  it("accepts a well-formed action-form widget", () => {
    const validated = validateWorkspaceDoc(withActionForm(validProps()));
    const widget = validated.tabs[0]!.widgets.find((w) => w.id === "action-1");
    expect(widget?.kind).toBe("builtin:action-form");
  });

  it("rejects a template slot that is not a declared field", () => {
    const props = validProps();
    props.template = "Deploy {service} as {evil}";
    expect(() => validateWorkspaceDoc(withActionForm(props))).toThrow(
      "template references unknown field: {evil}",
    );
  });

  it("rejects more than 8 fields", () => {
    const props = validProps();
    props.fields = Array.from({ length: 9 }, (_, index) => ({
      name: `f${index}`,
      label: `Field ${index}`,
      type: "text" as const,
      maxLength: 10,
    }));
    props.template = "{f0}";
    expect(() => validateWorkspaceDoc(withActionForm(props))).toThrow(
      "fields must contain 1 to 8 entries",
    );
  });

  it("rejects a select field without options", () => {
    const props = validProps();
    props.fields[1] = { name: "env", label: "Environment", type: "select" } as never;
    expect(() => validateWorkspaceDoc(withActionForm(props))).toThrow("options");
  });

  it("rejects an unknown field type", () => {
    const props = validProps();
    props.fields[0] = { name: "service", label: "Service", type: "textarea" } as never;
    expect(() => validateWorkspaceDoc(withActionForm(props))).toThrow(
      "type must be text, number, or select",
    );
  });

  it("rejects a template over the length cap", () => {
    const props = validProps();
    props.template = "{service} ".repeat(300);
    expect(() => validateWorkspaceDoc(withActionForm(props))).toThrow("template must be 1-2000");
  });

  it("rejects a maxLength over the per-field cap", () => {
    const props = validProps();
    props.fields[0]!.maxLength = 5000;
    expect(() => validateWorkspaceDoc(withActionForm(props))).toThrow("maxLength");
  });
});
