import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Sprint 21.1 — share tokens must not reach any log.
 *
 * Two independent surfaces, and both need guarding:
 *
 *  1. The platform. Cloudflare's invocation logs record the full request URL,
 *     and a shared page carries its bearer token in the path. That capture
 *     happens before user code runs, so no amount of in-Worker redaction can
 *     undo it — the only lever is the deploy config.
 *  2. The application. Nothing may print a token, a share URL, or a whole
 *     request URL, including from an error path.
 */

const ROOT = new URL("../", import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry.startsWith(".")) continue;
    const relative = join(dir, entry);
    if (statSync(join(ROOT, relative)).isDirectory()) sourceFiles(relative, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative);
  }
  return out;
}

const APP_DIRS = ["app", "lib", "worker", "db"];
const files = APP_DIRS.flatMap((dir) => sourceFiles(dir));

/** Comments describe the rule; they are not the behaviour under test. */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the deploy config keeps Workers observability disabled", () => {
  const config = readFileSync(join(ROOT, "scripts/cf-config.sh"), "utf8");
  assert.match(config, /"observability":\s*\{\s*"enabled":\s*false\s*\}/,
    "observability must stay off while share tokens live in the URL path");
  assert.doesNotMatch(config, /"observability":\s*\{\s*"enabled":\s*true\s*\}/);
  // The value must be a literal, not an env-driven toggle someone can flip
  // per-deploy without reading why it is off.
  assert.doesNotMatch(config, /"enabled":\s*"?\$\{?[A-Z_]*OBSERVABILITY/i,
    "observability must not be switchable from the environment");
});

test("no application code logs a request URL, a share URL or a token", () => {
  assert.ok(files.length > 20, "the scan actually found the source tree");

  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
    for (const [index, line] of source.split("\n").entries()) {
      if (!/console\.(log|info|warn|error|debug|trace)|process\.stdout|process\.stderr/.test(line)) continue;
      if (/request\.url|req\.url|\.href|pathname|token|shareUrl|\/share\//i.test(line)) {
        offenders.push(`${file}:${index + 1} ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `logging statement may expose a URL or token:\n${offenders.join("\n")}`);
});

test("the share route never puts a token into a response body or an error", () => {
  const route = readFileSync(join(ROOT, "app/share/[token]/route.ts"), "utf8");
  const code = stripComments(route);

  assert.doesNotMatch(code, /console\./, "the public route logs nothing at all");
  // `token` may only be read from params and handed to the hash lookup.
  const uses = code.split("\n").filter((line) => /\btoken\b/.test(line));
  for (const line of uses) {
    assert.match(line, /params|resolveShareByToken/,
      `token used outside the lookup path: ${line.trim()}`);
  }

  // Errors resolve to the shared generic response, never to a message that
  // could echo the request.
  assert.match(code, /catch\s*\{[\s\S]*shareUnavailableResponse\(\)/);
  assert.doesNotMatch(code, /error\.message|String\(error\)|caught/);
});

test("share responses cannot leak the token through referrer or cache", () => {
  const http = readFileSync(join(ROOT, "lib/share-http.ts"), "utf8");
  // A referrer would carry the full share URL to any third-party origin the
  // page linked to; no-store keeps it out of shared caches.
  assert.match(http, /"Referrer-Policy":\s*"no-referrer"/);
  assert.match(http, /no-store/);
  assert.match(http, /"X-Robots-Tag":\s*"noindex, nofollow, noarchive"/);
});
