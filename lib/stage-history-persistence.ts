export const STAGE_HISTORY_MUTATION_BATCH_SIZE = 40;

export type StageHistoryPersistenceRow = Readonly<{
  rowKey: string;
  dealId: string;
  createdAt: string;
  payload: string;
  syncedAt: string;
}>;

export type ExistingStageHistoryRow = Readonly<Omit<StageHistoryPersistenceRow, "syncedAt">>;

export const STAGE_HISTORY_GUARDED_UPSERT_SQL = `
  INSERT INTO raw_stage_history(row_key, deal_id, created_at, payload, synced_at)
  VALUES(?, ?, ?, ?, ?)
  ON CONFLICT(row_key) DO UPDATE SET
    deal_id = excluded.deal_id,
    created_at = excluded.created_at,
    payload = excluded.payload,
    synced_at = excluded.synced_at
  WHERE raw_stage_history.deal_id IS NOT excluded.deal_id
     OR raw_stage_history.created_at IS NOT excluded.created_at
     OR raw_stage_history.payload IS NOT excluded.payload
`;

export function stageHistoryRowKey(dealId: string, historyId: string, stageId: string, createdAt: string) {
  return `${dealId}:${historyId || `${stageId}:${createdAt}`}`;
}

export function stageHistoryMutationBatches<T>(rows: readonly T[]) {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += STAGE_HISTORY_MUTATION_BATCH_SIZE) {
    batches.push(rows.slice(index, index + STAGE_HISTORY_MUTATION_BATCH_SIZE));
  }
  return batches;
}

/**
 * Compare only persisted Bitrix history semantics. `syncedAt` deliberately does
 * not participate: refreshing the run marker alone would make every unchanged
 * history row a write.
 *
 * Repeated incoming row keys retain their final value. This preserves the
 * effective winner from the previous ordered INSERT OR REPLACE statements.
 */
export function planStageHistoryDiff(
  existingRows: readonly ExistingStageHistoryRow[],
  incomingRows: readonly StageHistoryPersistenceRow[],
) {
  const incomingByKey = new Map<string, StageHistoryPersistenceRow>();
  for (const row of incomingRows) incomingByKey.set(row.rowKey, row);

  const existingByKey = new Map(existingRows.map((row) => [row.rowKey, row]));
  const upserts = [...incomingByKey.values()].filter((incoming) => {
    const existing = existingByKey.get(incoming.rowKey);
    return !existing
      || existing.dealId !== incoming.dealId
      || existing.createdAt !== incoming.createdAt
      || existing.payload !== incoming.payload;
  });
  const staleRowKeys = [...existingByKey.keys()].filter((rowKey) => !incomingByKey.has(rowKey));

  return { upserts, staleRowKeys } as const;
}

export async function persistStageHistoryRows(
  db: D1Database,
  touchedDealIds: readonly string[],
  incomingRows: readonly StageHistoryPersistenceRow[],
) {
  if (!touchedDealIds.length) return { upserts: 0, deletes: 0 } as const;

  const placeholders = touchedDealIds.map(() => "?").join(", ");
  const existingResult = await db.prepare(
    `SELECT row_key, deal_id, created_at, payload FROM raw_stage_history WHERE deal_id IN (${placeholders})`,
  ).bind(...touchedDealIds).all<{
    row_key: string;
    deal_id: string;
    created_at: string;
    payload: string;
  }>();
  const existingRows: ExistingStageHistoryRow[] = (existingResult.results ?? []).map((row) => ({
    rowKey: String(row.row_key),
    dealId: String(row.deal_id),
    createdAt: String(row.created_at),
    payload: String(row.payload),
  }));
  const diff = planStageHistoryDiff(existingRows, incomingRows);

  for (const staleBatch of stageHistoryMutationBatches(diff.staleRowKeys)) {
    const stalePlaceholders = staleBatch.map(() => "?").join(", ");
    await db.prepare(
      `DELETE FROM raw_stage_history WHERE row_key IN (${stalePlaceholders})`,
    ).bind(...staleBatch).run();
  }

  for (const upsertBatch of stageHistoryMutationBatches(diff.upserts)) {
    await db.batch(upsertBatch.map((row) => db.prepare(STAGE_HISTORY_GUARDED_UPSERT_SQL).bind(
      row.rowKey,
      row.dealId,
      row.createdAt,
      row.payload,
      row.syncedAt,
    )));
  }

  return { upserts: diff.upserts.length, deletes: diff.staleRowKeys.length } as const;
}
