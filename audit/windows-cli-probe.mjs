import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { resolve, join } from "node:path";

const target = resolve(process.argv[2]);
const label = process.argv[3];
const cacheStudy = process.argv[4] === "cache-study";
const output = resolve("audit-results");
await mkdir(output, { recursive: true });
const source = "import(name)";
const sha256 = createHash("sha256").update(source).digest("hex");
const root = await mkdtemp(join(tmpdir(), "rea-cli-shutdown-audit-"));
await mkdir(join(root, "files", "modules"), { recursive: true });
await writeFile(join(root, "files", "modules", "main.js"), source);
const manifest = {
  capture_path: "/capture.json", capture_sha256: "a".repeat(64),
  capture_kind: "browser-scenario", source_evidence_id: null,
  capture_completeness: {
    status: "complete", equality_eligible: true, missing_sections: [], truncated_sections: [],
  },
  output_directory: root,
  analysis_input: { input_path: join(root, "files"), format: "directory" },
  limitations: [],
  scripts: [{
    url: "https://app.test/main.js?build=1#entry",
    source: { kind: "scenario-response", transaction_id: "txn", request_sequence: 1, response_sequence: 2, status: 200 },
    content: {
      state: "exported", relative_path: "modules/main.js", layout: "isolated", layout_reason: "fixture",
      sha256, bytes: Buffer.byteLength(source), media_type: "text/javascript", redacted: false,
      representation: "browser-decoded-response-bytes",
    },
  }],
};
const manifestPath = join(root, "manifest.json").replaceAll("\\", "/");
await writeFile(manifestPath, JSON.stringify(manifest));
const summary = {
  label, node: process.version, platform: process.platform, arch: process.arch,
  cpus: cpus().length, memoryBytes: totalmem(), executions: [],
};
try {
  const variants = cacheStudy
    ? Array.from({ length: 3 }, (_, index) => [
        { mode: "disabled", instrumented: true, index },
        { mode: "cold", instrumented: true, index },
        { mode: "warm", instrumented: true, index },
      ]).flat().concat([{ mode: "flush", instrumented: true, index: 0 }])
    : [false, true].flatMap(instrumented => Array.from({ length: 3 }, (_, index) => ({ mode: instrumented ? "diagnostic" : "plain", instrumented, index })));
  for (const { mode, instrumented, index } of variants) {
      const id = `${label}-${mode}-${index}`;
      const started = performance.now();
      const record = { id, instrumented, startedAt: Date.now(), stdoutFirstMs: null, stdoutLastMs: null, exitMs: null, closeMs: null, timedOut: false };
      const environment = {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() } : {}),
        REA_LOG_LEVEL: "silent", REA_BROWSER_EXECUTABLE: "relative-missing-browser",
        NODE_COMPILE_CACHE: join(root, mode === "cold" || mode === "warm" ? `cache-pair-${index}` : `cache-${id}`),
        ...(mode === "disabled" ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
        ...(mode === "flush" ? { REA_AUDIT_FLUSH_COMPILE_CACHE: "1" } : {}),
        ...(instrumented ? { REA_AUDIT_RESOURCE_LOG: join(output, `${id}-resources.jsonl`) } : {}),
      };
      const nodeArgs = [
        ...(instrumented ? ["--import", new URL("cli-resource-probe.mjs", import.meta.url).href] : []),
        join(target, "scripts", "rea.mjs"), "trace-web-module-imports", manifestPath, "0", "--json",
      ];
      const child = spawn(process.execPath, nodeArgs, { cwd: target, env: environment, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      const elapsed = () => Math.round(performance.now() - started);
      child.stdout.on("data", chunk => {
        record.stdoutFirstMs ??= elapsed();
        record.stdoutLastMs = elapsed();
        stdout += chunk;
      });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("exit", () => { record.exitMs = elapsed(); });
      let killTimer;
      const deadline = setTimeout(() => {
        record.timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      }, 15000);
      const result = await new Promise((resolveResult, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode, signal) => resolveResult({ exitCode, signal }));
      }).finally(() => { clearTimeout(deadline); clearTimeout(killTimer); });
      record.closeMs = elapsed();
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {}
      Object.assign(record, result, {
        correctResult: parsed?.operation === "trace_web_module_imports" && parsed?.normalized_result?.engine === null && parsed?.normalized_result?.source?.script_index === 0,
        stdoutBytes: Buffer.byteLength(stdout), stderr,
      });
      summary.executions.push(record);
      await writeFile(join(output, `${label}-summary.json`), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(record));
      await writeFile(join(output, `${id}-stdout.json`), stdout);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
if (summary.executions.some(result => result.timedOut || result.exitCode !== 0 || !result.correctResult)) process.exitCode = 1;
