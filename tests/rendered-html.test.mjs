import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("build contains production metadata and no starter preview marker", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  const bundle = await readFile(workerUrl, "utf8");
  assert.match(bundle, /Bitrix24 Deal Processing Dashboard/);
  assert.doesNotMatch(bundle, /codex-preview/);
  assert.doesNotMatch(bundle, /Starter Project/);
});
