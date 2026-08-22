import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const SHARE_MARKER = "Bu sahifa mavjud emas yoki ulashish havolasi faol emas.";

test("build contains production metadata and no starter preview marker", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  const bundle = await readFile(workerUrl, "utf8");
  assert.match(bundle, /Bitrix24 Deal Processing Dashboard/);
  assert.doesNotMatch(bundle, /codex-preview/);
  assert.doesNotMatch(bundle, /Starter Project/);
});

test("the share route is server-side only and never ships to the browser", async () => {
  const server = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.ok(server.includes(SHARE_MARKER), "the share renderer is built into the worker");
  assert.ok(server.includes("noindex, nofollow, noarchive"), "privacy headers are built in");

  const assetsUrl = new URL("../dist/client/assets/", import.meta.url);
  const assets = await readdir(assetsUrl);
  for (const asset of assets.filter((name) => name.endsWith(".js"))) {
    const code = await readFile(new URL(asset, assetsUrl), "utf8");
    assert.equal(code.includes(SHARE_MARKER), false, `share rendering must not reach the client bundle (${asset})`);
  }
});
