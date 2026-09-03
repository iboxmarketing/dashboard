import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import {
  persistStageHistoryRows,
  planStageHistoryDiff,
  stageHistoryRowKey,
  STAGE_HISTORY_GUARDED_UPSERT_SQL,
  STAGE_HISTORY_MUTATION_BATCH_SIZE,
  type StageHistoryPersistenceRow,
} from "../lib/stage-history-persistence";

type StoredRow = {
  row_key: string;
  deal_id: string;
  created_at: string;
  payload: string;
  synced_at: string;
};

function historyRow(
  rowKey: string,
  dealId: string,
  over: Partial<StageHistoryPersistenceRow> = {},
): StageHistoryPersistenceRow {
  return {
    rowKey,
    dealId,
    createdAt: "2026-08-01T09:00:00Z",
    payload: JSON.stringify({ ID: rowKey.split(":").at(-1), OWNER_ID: dealId, STAGE_ID: "NEW" }),
    syncedAt: "run-new",
    ...over,
  };
}

function createHarness() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE raw_stage_history (
      row_key TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX raw_stage_deal_idx ON raw_stage_history(deal_id);
  `);
  const mutationBatchSizes: number[] = [];
  const mutationBindCounts: number[] = [];
  const deleteBindCounts: number[] = [];
  let mutationAttempts = 0;
  let changedRows = 0;

  class BoundStatement {
    constructor(
      readonly sql: string,
      readonly statement: StatementSync,
      readonly bindings: readonly string[] = [],
    ) {}

    bind(...bindings: unknown[]) {
      return new BoundStatement(this.sql, this.statement, bindings.map(String));
    }

    all<T>() {
      return { results: this.statement.all(...this.bindings) as T[], meta: { rows_written: 0 } };
    }

    run() {
      const result = this.statement.run(...this.bindings);
      if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(this.sql)) {
        mutationAttempts += 1;
        mutationBindCounts.push(this.bindings.length);
        if (/^\s*DELETE/i.test(this.sql)) deleteBindCounts.push(this.bindings.length);
        changedRows += Number(result.changes);
      }
      return { success: true, meta: { rows_written: Number(result.changes), changes: Number(result.changes) } };
    }
  }

  const adapter = {
    prepare(sql: string) {
      return new BoundStatement(sql, sqlite.prepare(sql));
    },
    async batch(statements: BoundStatement[]) {
      mutationBatchSizes.push(statements.length);
      return statements.map((statement) => statement.run());
    },
  } as unknown as D1Database;

  function seed(...input: StageHistoryPersistenceRow[]) {
    const statement = sqlite.prepare(
      "INSERT INTO raw_stage_history(row_key, deal_id, created_at, payload, synced_at) VALUES(?, ?, ?, ?, ?)",
    );
    for (const row of input) statement.run(row.rowKey, row.dealId, row.createdAt, row.payload, row.syncedAt);
  }

  function rows() {
    return (sqlite.prepare("SELECT * FROM raw_stage_history ORDER BY row_key").all() as unknown as StoredRow[])
      .map((row) => ({ ...row }));
  }

  return {
    adapter,
    seed,
    rows,
    close: () => sqlite.close(),
    mutationBatchSizes,
    mutationBindCounts,
    deleteBindCounts,
    mutationAttempts: () => mutationAttempts,
    changedRows: () => changedRows,
  };
}

test("identical stored and incoming history needs no history data write", async (t) => {
  const db = createHarness(); t.after(db.close);
  const stored = historyRow("1:101", "1", { syncedAt: "run-old" });
  db.seed(stored);

  const result = await persistStageHistoryRows(db.adapter, ["1"], [{ ...stored, syncedAt: "run-new" }]);

  assert.deepEqual(result, { upserts: 0, deletes: 0 });
  assert.equal(db.mutationAttempts(), 0);
  assert.equal(db.changedRows(), 0);
});

test("new history is inserted", async (t) => {
  const db = createHarness(); t.after(db.close);
  const incoming = historyRow("1:101", "1");

  const result = await persistStageHistoryRows(db.adapter, ["1"], [incoming]);

  assert.deepEqual(result, { upserts: 1, deletes: 0 });
  assert.deepEqual(db.rows(), [{
    row_key: incoming.rowKey, deal_id: incoming.dealId, created_at: incoming.createdAt,
    payload: incoming.payload, synced_at: incoming.syncedAt,
  }]);
});

test("changed history payload is updated", async (t) => {
  const db = createHarness(); t.after(db.close);
  const stored = historyRow("1:101", "1", { payload: "old", syncedAt: "run-old" });
  const incoming = { ...stored, payload: "new", syncedAt: "run-new" };
  db.seed(stored);

  const result = await persistStageHistoryRows(db.adapter, ["1"], [incoming]);

  assert.deepEqual(result, { upserts: 1, deletes: 0 });
  assert.equal(db.rows()[0]?.payload, "new");
  assert.equal(db.rows()[0]?.synced_at, "run-new");
});

test("changed history created_at is updated", async (t) => {
  const db = createHarness(); t.after(db.close);
  const stored = historyRow("1:101", "1", { syncedAt: "run-old" });
  const incoming = { ...stored, createdAt: "2026-08-02T10:00:00Z", syncedAt: "run-new" };
  db.seed(stored);

  const result = await persistStageHistoryRows(db.adapter, ["1"], [incoming]);

  assert.deepEqual(result, { upserts: 1, deletes: 0 });
  assert.equal(db.rows()[0]?.created_at, incoming.createdAt);
});

test("one stale stored history row is deleted", async (t) => {
  const db = createHarness(); t.after(db.close);
  const retained = historyRow("1:101", "1");
  db.seed(retained, historyRow("1:102", "1"));

  const result = await persistStageHistoryRows(db.adapter, ["1"], [retained]);

  assert.deepEqual(result, { upserts: 0, deletes: 1 });
  assert.deepEqual(db.rows().map((row) => row.row_key), ["1:101"]);
});

test("a touched Deal returning zero history removes all of its old rows", async (t) => {
  const db = createHarness(); t.after(db.close);
  db.seed(historyRow("1:101", "1"), historyRow("1:102", "1"), historyRow("1:103", "1"));

  const result = await persistStageHistoryRows(db.adapter, ["1"], []);

  assert.deepEqual(result, { upserts: 0, deletes: 3 });
  assert.deepEqual(db.rows(), []);
});

test("mixed unchanged, new, changed, and deleted history persists the exact final set", async (t) => {
  const db = createHarness(); t.after(db.close);
  const unchanged = historyRow("1:101", "1", { syncedAt: "run-old" });
  const changed = historyRow("1:102", "1", { payload: "old", syncedAt: "run-old" });
  db.seed(unchanged, changed, historyRow("1:103", "1", { syncedAt: "run-old" }));
  const incomingChanged = { ...changed, payload: "new", syncedAt: "run-new" };
  const added = historyRow("1:104", "1");

  const result = await persistStageHistoryRows(db.adapter, ["1"], [
    { ...unchanged, syncedAt: "run-new" }, incomingChanged, added,
  ]);

  assert.deepEqual(result, { upserts: 2, deletes: 1 });
  assert.deepEqual(db.rows().map((row) => [row.row_key, row.payload]), [
    ["1:101", unchanged.payload], ["1:102", "new"], ["1:104", added.payload],
  ]);
});

test("multiple touched Deals are reconciled without affecting untouched Deals", async (t) => {
  const db = createHarness(); t.after(db.close);
  const dealOne = historyRow("1:101", "1", { syncedAt: "run-old" });
  const dealTwo = historyRow("2:201", "2", { syncedAt: "run-old" });
  const untouched = historyRow("3:301", "3", { syncedAt: "run-old" });
  db.seed(dealOne, dealTwo, untouched);

  const result = await persistStageHistoryRows(db.adapter, ["1", "2"], [
    { ...dealOne, syncedAt: "run-new" }, historyRow("2:202", "2"),
  ]);

  assert.deepEqual(result, { upserts: 1, deletes: 1 });
  assert.deepEqual(db.rows().map((row) => row.row_key), ["1:101", "2:202", "3:301"]);
});

test("stage-history row_key generation remains byte-for-byte compatible", () => {
  assert.equal(stageHistoryRowKey("42", "9001", "C1:NEW", "2026-08-01T09:00:00Z"), "42:9001");
  assert.equal(
    stageHistoryRowKey("42", "", "C1:NEW", "2026-08-01T09:00:00Z"),
    "42:C1:NEW:2026-08-01T09:00:00Z",
  );
});

test("an empty table after Full clear rebuilds from incoming history", async (t) => {
  const db = createHarness(); t.after(db.close);
  const incoming = [historyRow("1:101", "1"), historyRow("1:102", "1")];

  const result = await persistStageHistoryRows(db.adapter, ["1"], incoming);

  assert.deepEqual(result, { upserts: 2, deletes: 0 });
  assert.deepEqual(db.rows().map((row) => row.row_key), ["1:101", "1:102"]);
});

test("synced_at alone neither plans nor performs an update", async (t) => {
  const db = createHarness(); t.after(db.close);
  const stored = historyRow("1:101", "1", { syncedAt: "run-old" });
  const incoming = { ...stored, syncedAt: "run-new" };
  db.seed(stored);

  const plan = planStageHistoryDiff([{
    rowKey: stored.rowKey, dealId: stored.dealId, createdAt: stored.createdAt, payload: stored.payload,
  }], [incoming]);
  assert.deepEqual(plan, { upserts: [], staleRowKeys: [] });

  const direct = db.adapter.prepare(STAGE_HISTORY_GUARDED_UPSERT_SQL).bind(
    incoming.rowKey, incoming.dealId, incoming.createdAt, incoming.payload, incoming.syncedAt,
  );
  const result = await direct.run();
  assert.equal(result.meta.rows_written, 0);
  assert.equal(db.rows()[0]?.synced_at, "run-old");
});

test("stage-history deletes and upserts stay within the existing 40-row mutation bound", async (t) => {
  const db = createHarness(); t.after(db.close);
  const stored = Array.from({ length: 85 }, (_, index) => historyRow(`1:old-${index}`, "1"));
  const incoming = Array.from({ length: 95 }, (_, index) => historyRow(`1:new-${index}`, "1"));
  db.seed(...stored);

  const result = await persistStageHistoryRows(db.adapter, ["1"], incoming);

  assert.deepEqual(result, { upserts: 95, deletes: 85 });
  assert.deepEqual(db.mutationBatchSizes, [40, 40, 15]);
  assert.ok(db.mutationBindCounts.every((count) => count <= STAGE_HISTORY_MUTATION_BATCH_SIZE));
  assert.deepEqual(db.deleteBindCounts, [40, 40, 5]);
});

test("duplicate incoming row keys retain the final value like ordered INSERT OR REPLACE", async (t) => {
  const db = createHarness(); t.after(db.close);
  const first = historyRow("1:101", "1", { payload: "first" });
  const last = historyRow("1:101", "1", { payload: "last" });

  const result = await persistStageHistoryRows(db.adapter, ["1"], [first, last]);

  assert.deepEqual(result, { upserts: 1, deletes: 0 });
  assert.equal(db.rows()[0]?.payload, "last");
});
