import { spawn } from "node:child_process";

const SECRET_KEY = /(secret|token|password|passwd|credential|private[_-]?key|webhook)/i;

export function safeEnvironment(extra = {}) {
  const allowed = [
    "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  const env = Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  for (const [key, value] of Object.entries(extra)) {
    if (!SECRET_KEY.test(key) && value !== undefined) env[key] = String(value);
  }
  return env;
}

export function redact(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+\/rest\/\d+\/[A-Za-z0-9_-]{8,}\/?/gi, "[REDACTED_BITRIX_URL]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,"']+/gi, "$1[REDACTED]");
}

export async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutput = options.maxOutput ?? 1_000_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? safeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => (current + chunk).slice(-maxOutput);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      // Commands such as `--version` may exit before consuming stdin.
      if (error.code !== "EPIPE") reject(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, signal, stdout: redact(stdout), stderr: redact(stderr), timedOut };
      if (code === 0 && !timedOut) resolve(result);
      else reject(Object.assign(new Error(`${command} failed${timedOut ? " (timeout)" : ""}: ${result.stderr.slice(-4000)}`), { result }));
    });
    child.stdin.end(options.input ?? "");
  });
}

export async function commandVersion(command, args, cwd) {
  const result = await runCommand(command, args, { cwd, timeoutMs: 20_000, maxOutput: 20_000 });
  return (result.stdout || result.stderr).trim().split("\n")[0];
}
