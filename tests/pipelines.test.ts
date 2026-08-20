import assert from "node:assert/strict";
import test from "node:test";
import { normalizePipelineName, resolvePipelineSelection } from "../lib/pipelines";

const options = [
  { id: "1", name: "Call Center" },
  { id: "2", name: "IBOX Sales" },
  { id: "3", name: "SD Sales" },
];

test("pipeline nomi katta-kichik harf va bo‘shliqlardan qat’i nazar topiladi", () => {
  assert.equal(normalizePipelineName("  IBOX--Sales "), "ibox sales");
  assert.deepEqual(resolvePipelineSelection(options, [], ["ibox sales", "sd sales"]).map((item) => item.id), ["2", "3"]);
});

test("call center pipeline tanlovga kirmaydi", () => {
  assert.deepEqual(resolvePipelineSelection(options, ["2", "3"], []).map((item) => item.name), ["IBOX Sales", "SD Sales"]);
});

test("ikki aniq sales pipeline topilmasa sync rad etiladi", () => {
  assert.throws(() => resolvePipelineSelection(options.slice(0, 2), [], ["IBOX Sales", "SD Sales"]), /aniq topilmadi/);
});
