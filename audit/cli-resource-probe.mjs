import { createHook } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { flushCompileCache } from "node:module";

const filename = process.env.REA_AUDIT_RESOURCE_LOG;
const started = performance.now();
const tracked = new Set([
  "Timeout", "PIPEWRAP", "TCPWRAP", "TCPCONNECTWRAP", "PROCESSWRAP",
  "WORKER", "FSEVENTWRAP", "SIGNALWRAP", "GETADDRINFOREQWRAP", "MESSAGEPORT",
]);
const resources = new Map();
const hook = createHook({
  init(id, type, trigger, resource) {
    if (!tracked.has(type)) return;
    resources.set(id, {
      type, trigger, resource,
      createdMs: Math.round(performance.now() - started),
      stack: new Error().stack?.split("\n").slice(2, 12),
    });
  },
  destroy(id) { resources.delete(id); },
});
hook.enable();
function record(event) {
  const report = process.report.getReport();
  appendFileSync(filename, JSON.stringify({
    event, timestamp: Date.now(), elapsedMs: Math.round(performance.now() - started),
    resources: process.getActiveResourcesInfo(),
    tracked: [...resources].map(([id, entry]) => ({
      id, type: entry.type, trigger: entry.trigger, createdMs: entry.createdMs,
      hasRef: typeof entry.resource.hasRef === "function" ? entry.resource.hasRef() : null,
      stack: entry.stack,
    })),
    libuv: report.libuv,
    resourceUsage: report.resourceUsage,
  }) + "\n");
}
record("start");
setInterval(() => record("interval"), 1000).unref();
process.on("beforeExit", () => {
  record("beforeExit");
  if (process.env.REA_AUDIT_FLUSH_COMPILE_CACHE === "1") {
    const flushStarted = performance.now();
    flushCompileCache();
    appendFileSync(filename, JSON.stringify({ event: "cache-flush", timestamp: Date.now(), durationMs: Math.round(performance.now() - flushStarted) }) + "\n");
    record("afterFlush");
  }
});
process.on("exit", () => record("exit"));
