-- Stage Control: the last successful live Bitrix fetch per project, served
-- (labelled as such) when live Bitrix times out.
--
-- Additive only: one new table. No existing table is touched. Generated from
-- lib/stage-control-live.ts (a test keeps the two identical); the Worker also
-- creates it on first use, so a Stage Control request never depends on this
-- file having been applied first.
CREATE TABLE IF NOT EXISTS stage_control_snapshots (
  project_key TEXT PRIMARY KEY NOT NULL,
  workspace_key TEXT NOT NULL,
  category_ids TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
