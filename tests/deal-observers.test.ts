import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attachDealObservers,
  buildDealObserverRead,
  DEAL_OBSERVERS_FIELD,
  observerItemIds,
  singlePostSaleObserverId,
} from "../lib/deal-observers";

test("Bitrix Deal observers use the documented universal crm.item field", () => {
  const request = buildDealObserverRead(["41", "42", "41"]);
  assert.equal(DEAL_OBSERVERS_FIELD, "observers");
  assert.equal(request.method, "crm.item.list");
  assert.deepEqual(request.params, {
    entityTypeId: 2,
    select: ["id", "observers"],
    filter: { "@id": ["41", "42"] },
  });
});

test("universal observer values are persisted on the existing raw Deal input", () => {
  const deals = [
    { ID: "41", CATEGORY_ID: "13", ASSIGNED_BY_ID: "20" },
    { ID: "42", CATEGORY_ID: "3", ASSIGNED_BY_ID: "7" },
  ];
  const items = [{ id: 41, observers: [7] }];
  const merged = attachDealObservers(deals, items);
  assert.deepEqual(merged[0], { ...deals[0], observers: [7] });
  assert.deepEqual(merged[1], deals[1]);
  assert.deepEqual([...observerItemIds(items)], ["41"]);
});

test("observer handoff candidates are evaluated after subtracting the assigned operator", () => {
  assert.equal(singlePostSaleObserverId([7], "20"), "7");
  assert.equal(singlePostSaleObserverId([], "20"), "");
  assert.equal(singlePostSaleObserverId([0], "20"), "");
  assert.equal(singlePostSaleObserverId([7, 9], "20"), "");
  assert.equal(singlePostSaleObserverId([7, 20], "20"), "7",
    "[seller, assigned operator] leaves the seller as the one handoff candidate");
  assert.equal(singlePostSaleObserverId([7, 9, 20], "20"), "",
    "two non-assignee observers remain ambiguous");
  assert.equal(singlePostSaleObserverId([7], "7"), "");
  assert.equal(singlePostSaleObserverId([7, 7], "20"), "7", "duplicate copies of one user are still one candidate");
});

test("sync enriches post-sale pages without replacing the legacy Deal integration", () => {
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /enrichPostSaleObservers\(deals, postSaleCategoryIds\)/);
  assert.match(sync, /buildDealObserverRead\(ids\)/);
  assert.match(sync, /crm\.deal\.list/, "the established Deal fetch remains in place");
  assert.doesNotMatch(sync, /["'](?:OBSERVER|OBSERVERS|OBSERVER_IDS)["']/,
    "no guessed legacy observer field is selected");
});
