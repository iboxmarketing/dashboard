import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Runs after `npm run build`. The auth fixture identities live in
 * tests/auth-fixture-adapter.ts; none of them — names, emails, ids, or the
 * fixture adapter itself — may reach either production bundle.
 */
const fixtureSource = await readFile(new URL("./auth-fixture-adapter.ts", import.meta.url), "utf8");
const usersBlock = fixtureSource.slice(fixtureSource.indexOf("AUTH_FIXTURE_USERS"), fixtureSource.indexOf("];"));
const pick = (key) => [...usersBlock.matchAll(new RegExp(`${key}: "([^"]+)"`, "g"))].map((match) => match[1]);
const FIXTURE_STRINGS = [...pick("email"), ...pick("name"), ...pick("id"), "createFixtureAuthAdapter", "AUTH_FIXTURE_USERS", "cloneAuthFixtures"];

async function bundles() {
  const assetsUrl = new URL("../dist/client/assets/", import.meta.url);
  const files = (await readdir(assetsUrl)).filter((name) => name.endsWith(".js")).map((name) => new URL(name, assetsUrl));
  files.push(new URL("../dist/server/index.js", import.meta.url));
  return Promise.all(files.map(async (url) => ({ name: url.pathname.split("/").pop(), code: await readFile(url, "utf8") })));
}

test("no auth fixture identity reaches the production client or server bundle", async () => {
  assert.ok(FIXTURE_STRINGS.length >= 20, "the fixture list was read, not assumed");
  for (const { name, code } of await bundles()) {
    for (const value of FIXTURE_STRINGS) assert.equal(code.includes(value), false, `${value} found in ${name}`);
  }
});
