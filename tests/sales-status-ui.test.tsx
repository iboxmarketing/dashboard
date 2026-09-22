import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyCohortNotice, SectionStatus, type SectionState } from "../app/sales-data";

/**
 * Sales section states, rendered. A section is one of: first load, refreshing
 * over the previous figures, not ready, refused, failed (with a retry), or
 * loaded. The empty-cohort note must not claim there were no sales.
 */

const base: SectionState<unknown> = { data: null, loading: false, notReady: false, error: null, forbidden: false, code: null, retry: () => {} };
const render = (state: Partial<SectionState<unknown>>) => renderToStaticMarkup(<SectionStatus state={{ ...base, ...state }} />);
const client = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");

test("first load shows a labelled skeleton; a refresh over existing figures says it is updating", () => {
  const first = render({ loading: true });
  assert.match(first, /aria-busy="true"/);
  assert.match(first, /Ma’lumotlar yuklanmoqda…/);
  const refreshing = render({ loading: true, data: { ready: true } });
  assert.match(refreshing, /role="status"/);
  assert.match(refreshing, /aria-live="polite"/);
  assert.match(refreshing, /yangilanmoqda…/);
  assert.equal(render({ data: { ready: true } }), "", "a loaded section shows no status");
});

test("a failed section offers a retry, a refused one does not", () => {
  const failed = render({ error: "Sales ma’lumotlarini yuklab bo‘lmadi" });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Qayta urinish/);
  const refused = render({ error: "Ruxsat yo‘q", forbidden: true });
  assert.match(refused, /notice warning/);
  assert.doesNotMatch(refused, /Qayta urinish/);
  assert.match(render({ notReady: true }), /hali tayyor emas/);
});

test("an empty cohort is explained without claiming there were no sales", () => {
  const html = renderToStaticMarkup(<EmptyCohortNotice />);
  assert.match(html, /yangi Lead yo‘q/);
  assert.match(html, /Davr sotuvlari Oplata sanasi bo‘yicha alohida/);
  assert.match(client, /dashboardSection\.data\.leadCount === 0 && <EmptyCohortNotice \/>/);
  assert.match(client, /leadFlowSection\.data\.flow\.total === 0 && <EmptyCohortNotice \/>/);
});
