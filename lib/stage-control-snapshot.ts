import { getD1 } from "@/db";
import type { ProjectKey } from "./sales-projects";
import {
  parseSnapshotPayload, SNAPSHOT_READ_SQL, SNAPSHOT_UPSERT_SQL, snapshotBindings, STAGE_CONTROL_SCHEMA_STATEMENTS,
  type StageControlSnapshot,
} from "./stage-control-live";

/**
 * Last-successful live Stage Control snapshots, in their own table. Not in
 * `crm_dictionaries`: that table's `updated_at` is part of the Sales cache
 * fingerprint, and a write on every Stage Control load would invalidate it.
 */
type D1 = ReturnType<typeof getD1>;
const ensured = new WeakSet<object>();

async function ensureStageControlSchema(db: D1) {
  if (ensured.has(db)) return;
  await db.batch(STAGE_CONTROL_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
  ensured.add(db);
}

export async function readStageControlSnapshot(project: ProjectKey): Promise<unknown> {
  const db = getD1();
  await ensureStageControlSchema(db);
  const row = await db.prepare(SNAPSHOT_READ_SQL).bind(project).first<{ payload: string }>();
  return parseSnapshotPayload(row?.payload);
}

export async function writeStageControlSnapshot(snapshot: StageControlSnapshot): Promise<void> {
  const db = getD1();
  await ensureStageControlSchema(db);
  await db.prepare(SNAPSHOT_UPSERT_SQL).bind(...snapshotBindings(snapshot, new Date().toISOString())).run();
}
