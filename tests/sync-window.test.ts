import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_OVERLAP_MINUTES, parseCheckpoint, resolveSyncWindow } from "../lib/sync-window";

/** Tashkent wall-clock helper, matching the timezone the dashboard reports in. */
function at(local: string) {
  return new Date(`${local}:00+05:00`);
}
function iso(local: string) {
  return at(local).toISOString();
}
const BOOTSTRAP_DAYS = 90;

test("Case 1: tez-tez sync — oyna oxirgi muvaffaqiyatli sync minus 10 minutdan boshlanadi", () => {
  const window = resolveSyncWindow({
    lastSuccessfulSyncAt: iso("2026-08-21T10:00"),
    now: at("2026-08-21T10:30"),
    bootstrapDays: BOOTSTRAP_DAYS,
  });
  assert.equal(window.mode, "incremental");
  assert.equal(window.reason, "CHECKPOINT");
  assert.equal(window.from.toISOString(), iso("2026-08-21T09:50"));
});

test("Case 2: dashboard 3 kun ochilmasa ham Aug 18 11:50 dan boshlanadi", () => {
  const window = resolveSyncWindow({
    lastSuccessfulSyncAt: iso("2026-08-18T12:00"),
    now: at("2026-08-21T12:00"),
    bootstrapDays: BOOTSTRAP_DAYS,
  });
  assert.equal(window.mode, "incremental");
  assert.equal(window.from.toISOString(), iso("2026-08-18T11:50"));
  // The regression itself: the old Math.max floor produced Aug 20 12:00 and
  // permanently dropped Aug 18–20 modifications.
  assert.notEqual(window.from.toISOString(), iso("2026-08-20T12:00"));
});

test("Case 3: 24 soatlik kesish qayta paydo bo‘lmaydi", () => {
  const now = at("2026-08-21T12:00");
  const gaps = [
    { label: "2 kun", last: iso("2026-08-19T12:00"), expected: iso("2026-08-19T11:50") },
    { label: "7 kun", last: iso("2026-08-14T12:00"), expected: iso("2026-08-14T11:50") },
    { label: "30 kun", last: iso("2026-07-22T12:00"), expected: iso("2026-07-22T11:50") },
    { label: "180 kun", last: iso("2026-02-22T12:00"), expected: iso("2026-02-22T11:50") },
  ];
  for (const gap of gaps) {
    const window = resolveSyncWindow({ lastSuccessfulSyncAt: gap.last, now, bootstrapDays: BOOTSTRAP_DAYS });
    assert.equal(window.mode, "incremental", gap.label);
    assert.equal(window.from.toISOString(), gap.expected, gap.label);
    // Every window reaches further back than the old 24h floor.
    assert.ok(window.from.getTime() < now.getTime() - 86_400_000, `${gap.label} 24 soatdan uzoqroqqa yetishi kerak`);
  }
});

test("Case 4: muvaffaqiyatli sync bo‘lmagan bo‘lsa bootstrap full oyna ishlatiladi", () => {
  const now = at("2026-08-21T12:00");
  const window = resolveSyncWindow({ lastSuccessfulSyncAt: null, now, bootstrapDays: BOOTSTRAP_DAYS });
  assert.equal(window.mode, "full");
  assert.equal(window.reason, "NO_CHECKPOINT");
  assert.equal(window.from.toISOString(), new Date(now.getTime() - BOOTSTRAP_DAYS * 86_400_000).toISOString());
});

test("Case 5: tugallanmagan sync checkpoint’ni surmaydi, keyingi sync eski nuqtadan davom etadi", () => {
  // A run started at 12:00 fails midway. The checkpoint in D1 is written only
  // by the drained analytics phase, so it still holds the Aug 18 value.
  const checkpointAfterFailedRun = iso("2026-08-18T12:00");
  const retry = resolveSyncWindow({
    lastSuccessfulSyncAt: checkpointAfterFailedRun,
    now: at("2026-08-21T18:00"),
    bootstrapDays: BOOTSTRAP_DAYS,
  });
  assert.equal(retry.mode, "incremental");
  assert.equal(retry.from.toISOString(), iso("2026-08-18T11:50"));
});

test("full sync so‘ralganda checkpoint e’tiborga olinmaydi va bootstrap oyna qoladi", () => {
  const now = at("2026-08-21T12:00");
  const window = resolveSyncWindow({
    lastSuccessfulSyncAt: iso("2026-08-21T11:00"),
    now,
    bootstrapDays: 30,
    full: true,
  });
  assert.equal(window.mode, "full");
  assert.equal(window.reason, "FULL_REQUESTED");
  assert.equal(window.from.toISOString(), new Date(now.getTime() - 30 * 86_400_000).toISOString());
});

test("buzilgan checkpoint 10 minutlik oyna emas, bootstrap sync beradi", () => {
  const now = at("2026-08-21T12:00");
  const window = resolveSyncWindow({ lastSuccessfulSyncAt: "not-a-date", now, bootstrapDays: BOOTSTRAP_DAYS });
  assert.equal(window.mode, "full");
  assert.equal(window.reason, "INVALID_CHECKPOINT");
  assert.equal(window.from.toISOString(), new Date(now.getTime() - BOOTSTRAP_DAYS * 86_400_000).toISOString());
});

test("kelajakdagi checkpoint bo‘sh oyna hosil qilmaydi", () => {
  const now = at("2026-08-21T12:00");
  const window = resolveSyncWindow({ lastSuccessfulSyncAt: iso("2026-08-23T12:00"), now, bootstrapDays: BOOTSTRAP_DAYS });
  assert.equal(window.mode, "incremental");
  assert.equal(window.from.toISOString(), iso("2026-08-21T11:50"));
  assert.ok(window.from.getTime() < now.getTime());
});

test("bootstrap kunlari 1..365 oralig‘iga siqiladi", () => {
  const now = at("2026-08-21T12:00");
  const tooLarge = resolveSyncWindow({ lastSuccessfulSyncAt: null, now, bootstrapDays: 10_000 });
  const tooSmall = resolveSyncWindow({ lastSuccessfulSyncAt: null, now, bootstrapDays: 0 });
  assert.equal(tooLarge.from.toISOString(), new Date(now.getTime() - 365 * 86_400_000).toISOString());
  assert.equal(tooSmall.from.toISOString(), new Date(now.getTime() - 1 * 86_400_000).toISOString());
});

test("overlap 10 minut bo‘lib qoladi", () => {
  assert.equal(SYNC_OVERLAP_MINUTES, 10);
  const now = at("2026-08-21T12:00");
  assert.equal(parseCheckpoint(iso("2026-08-21T11:00"), now)?.toISOString(), iso("2026-08-21T11:00"));
  assert.equal(parseCheckpoint(null, now), null);
  assert.equal(parseCheckpoint("", now), null);
});
