import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DEFAULT_DASHBOARD_WORKSPACE } from "./default-workspace.js";
import {
  migrateWorkspaceDoc,
  validateWorkspaceDoc,
  type JsonValue,
  type WorkspaceDoc,
} from "./schema.js";

export type DashboardMutationOptions = { actor: string };
export type DashboardMutationResult = { doc: WorkspaceDoc; changed: boolean };

/** A persisted widget-state envelope: the widget's opaque blob plus write metadata. */
export type WidgetStateRecord = { version: number; updatedAt: string; blob: JsonValue };
export type WidgetStateWriteResult = { version: number };

const MAX_WORKSPACE_BYTES = 256 * 1024;
const UNDO_RING_SIZE = 20;
// Hard per-widget state cap, enforced on the SERIALIZED envelope BEFORE any write.
// Separate from (and smaller than) the 256 KB workspace cap so state blobs never
// count against the workspace document.
const MAX_WIDGET_STATE_BYTES = 64 * 1024;
// The widget id is used as a filename segment under `state/`; it must match the
// same charset the workspace schema/gateway enforce for widget ids so a caller can
// never smuggle a path separator or traversal into the state directory.
const WIDGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function serializeWorkspaceDoc(doc: WorkspaceDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function assertWorkspaceSize(serialized: string): void {
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_BYTES) {
    throw new Error("workspace document exceeds 256 KB");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defensively normalize a persisted widget-state envelope read from disk. A file
 * that predates this format (or was hand-edited) still yields a usable record; the
 * `blob` is passed through opaquely (the widget owns its own shape).
 */
function validateWidgetStateRecord(value: unknown): WidgetStateRecord {
  if (!isRecord(value)) {
    throw new Error("widget state file is malformed");
  }
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 0
      ? value.version
      : 0;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  return { version, updatedAt, blob: (value.blob ?? null) as JsonValue };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

export class DashboardStore {
  readonly stateDir: string;
  readonly dashboardDir: string;
  readonly workspacePath: string;
  readonly undoDir: string;
  readonly widgetStateDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { stateDir?: string } = {}) {
    this.stateDir = options.stateDir ?? resolveStateDir();
    this.dashboardDir = path.join(this.stateDir, "dashboard");
    this.workspacePath = path.join(this.dashboardDir, "workspace.json");
    this.undoDir = path.join(this.dashboardDir, "undo");
    this.widgetStateDir = path.join(this.dashboardDir, "state");
  }

  /**
   * Resolve the on-disk file for one widget's persisted state. The charset guard
   * already forbids separators / traversal, but containment is re-checked so the
   * resolved path can never escape the `state/` jail (belt-and-braces, mirroring
   * `resolveWidgetDir` in manifest.ts).
   */
  private resolveWidgetStatePath(widgetId: string): string {
    if (!WIDGET_ID_PATTERN.test(widgetId)) {
      throw new Error("widget id is invalid");
    }
    const stateRoot = path.resolve(this.widgetStateDir);
    const filePath = path.resolve(stateRoot, `${widgetId}.json`);
    if (!filePath.startsWith(`${stateRoot}${path.sep}`)) {
      throw new Error("widget id is invalid");
    }
    return filePath;
  }

  /** Read a widget's persisted state envelope, or null if it has never been written. */
  async readWidgetState(widgetId: string): Promise<WidgetStateRecord | null> {
    const filePath = this.resolveWidgetStatePath(widgetId);
    const raw = await readJsonFile(filePath);
    if (raw === undefined) {
      return null;
    }
    return validateWidgetStateRecord(raw);
  }

  /**
   * Persist a widget's opaque blob under `state/<widgetId>.json`. The serialized
   * envelope is size-capped BEFORE the write, so an oversize blob is rejected WHOLE
   * (nothing is written). Writes are serialized through the process mutex and land
   * atomically; the version increments per successful write for change markers.
   */
  async writeWidgetState(widgetId: string, blob: JsonValue): Promise<WidgetStateWriteResult> {
    const filePath = this.resolveWidgetStatePath(widgetId);
    return await this.runExclusive(async () => {
      const previous = await this.readWidgetState(widgetId).catch(() => null);
      const record: WidgetStateRecord = {
        version: (previous?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        blob,
      };
      const serialized = `${JSON.stringify(record, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_WIDGET_STATE_BYTES) {
        throw new Error("widget state exceeds 64 KB");
      }
      await fs.mkdir(this.widgetStateDir, { recursive: true, mode: 0o700 });
      await replaceFileAtomic({
        filePath,
        content: serialized,
        mode: 0o600,
        tempPrefix: ".dashboard-widget-state",
        throwOnCleanupError: true,
      });
      return { version: record.version };
    });
  }

  async read(): Promise<WorkspaceDoc> {
    const raw = await readJsonFile(this.workspacePath);
    if (raw === undefined) {
      const seeded = validateWorkspaceDoc(structuredClone(DEFAULT_DASHBOARD_WORKSPACE));
      await this.writeWorkspaceDoc(seeded);
      return seeded;
    }
    const migrated = migrateWorkspaceDoc(raw);
    if (migrated.changed) {
      await this.writeWorkspaceDoc(migrated.doc);
    }
    return migrated.doc;
  }

  async mutate(
    fn: (draft: WorkspaceDoc) => WorkspaceDoc | void | Promise<WorkspaceDoc | void>,
    _options: DashboardMutationOptions,
  ): Promise<DashboardMutationResult> {
    return await this.runExclusive(async () => {
      const current = await this.read();
      const draft = structuredClone(current);
      const returned = await fn(draft);
      const candidate = returned === undefined ? draft : returned;
      candidate.workspaceVersion = current.workspaceVersion + 1;
      const next = validateWorkspaceDoc(candidate);
      const serialized = serializeWorkspaceDoc(next);
      assertWorkspaceSize(serialized);
      await this.writeUndoSnapshot(current, next.workspaceVersion);
      await this.writeWorkspaceSerialized(serialized);
      return { doc: next, changed: true };
    });
  }

  async replace(
    doc: WorkspaceDoc,
    options: DashboardMutationOptions,
  ): Promise<DashboardMutationResult> {
    return await this.mutate(() => structuredClone(doc), options);
  }

  async undo(): Promise<WorkspaceDoc> {
    return await this.runExclusive(async () => {
      const files = await this.listUndoFiles();
      const newest = files.at(-1);
      if (!newest) {
        throw new Error("no dashboard undo snapshot available");
      }
      const snapshotPath = path.join(this.undoDir, newest);
      const snapshot = validateWorkspaceDoc(await readJsonFile(snapshotPath));
      const serialized = serializeWorkspaceDoc(snapshot);
      assertWorkspaceSize(serialized);
      await this.writeWorkspaceSerialized(serialized);
      await fs.rm(snapshotPath, { force: true });
      return snapshot;
    });
  }

  private async runExclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    // One gateway process is the only writer; this promise chain serializes
    // all RPC/tool/CLI callers so read-modify-write cycles cannot interleave.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  private async writeWorkspaceDoc(doc: WorkspaceDoc): Promise<void> {
    const serialized = serializeWorkspaceDoc(doc);
    assertWorkspaceSize(serialized);
    await this.writeWorkspaceSerialized(serialized);
  }

  private async writeWorkspaceSerialized(serialized: string): Promise<void> {
    await fs.mkdir(this.dashboardDir, { recursive: true, mode: 0o700 });
    await replaceFileAtomic({
      filePath: this.workspacePath,
      content: serialized,
      mode: 0o600,
      tempPrefix: ".dashboard-workspace",
      throwOnCleanupError: true,
    });
  }

  private async writeUndoSnapshot(doc: WorkspaceDoc, nextWorkspaceVersion: number): Promise<void> {
    await fs.mkdir(this.undoDir, { recursive: true, mode: 0o700 });
    await replaceFileAtomic({
      filePath: path.join(this.undoDir, `${String(nextWorkspaceVersion).padStart(4, "0")}.json`),
      content: serializeWorkspaceDoc(doc),
      mode: 0o600,
      tempPrefix: ".dashboard-undo",
      throwOnCleanupError: true,
    });
    const files = await this.listUndoFiles();
    const evict = files.slice(0, Math.max(0, files.length - UNDO_RING_SIZE));
    await Promise.all(
      evict.map((fileName) => fs.rm(path.join(this.undoDir, fileName), { force: true })),
    );
  }

  private async listUndoFiles(): Promise<string[]> {
    try {
      return (await fs.readdir(this.undoDir))
        .filter((fileName) => /^\d+\.json$/.test(fileName))
        .toSorted();
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }
}
