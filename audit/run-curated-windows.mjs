import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

const target = resolve(process.argv[2]);
const require = createRequire(join(target, "package.json"));
const { parse } = require("yaml");
const workflow = parse(await readFile(join(target, ".github/workflows/ci.yml"), "utf8"));
const command = workflow.jobs["windows-curated"].steps.find(step => step.name === "Run curated Windows capability tests")?.run;
if (!command?.startsWith("npx vitest run --coverage.enabled=false ")) throw new Error("Unexpected curated Windows command");
const args = command.trim().split(/\s+/u).slice(2);
console.log(JSON.stringify({ command, files: args.filter(arg => arg.endsWith(".test.ts")).length }));
const child = spawn(process.execPath, [join(target, "node_modules/vitest/vitest.mjs"), ...args], { cwd: target, env: process.env, stdio: "inherit" });
child.on("error", error => { throw error; });
child.on("close", code => { process.exitCode = code ?? 1; });
