/**
 * B2b/B4: OMP execute_session wiring + workers retired.
 * Task: .workflow/tasks/b4-delete-drivers.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const SESSION_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "execute_session.ts");
const WORKER_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "execute_worker.ts");
const CONFIG_YML = nodePath.join(REPO_ROOT, "ports", "omp", "config.yml");
const AGENTS_MD = nodePath.join(REPO_ROOT, "ports", "omp", "AGENTS.md");

test("execute_session.ts source must not contain claude exec or runWorker", () => {
  const src = readFileSync(SESSION_SRC, "utf-8");
  assert.match(src, /execute_session/, "tool file exists");
  assert.doesNotMatch(src, /\brunWorker\b/, "must not import/call runWorker");
  assert.doesNotMatch(src, /pi\.exec\(\s*["']claude["']/, "must not pi.exec(claude)");
  assert.doesNotMatch(src, /["']claude["']/, "must not reference claude binary/string");
  assert.match(src, /runJudgeCli/, "must reuse B1 judge");
  assert.match(src, /zoneCheck/, "must reuse zoneCheck");
  assert.match(src, /loadZoneMap|resolveAgent/, "must reuse zonemap helpers");
  assert.match(src, /active-zone\.json/, "writes worker zone file");
});

test("config.yml registers execute_session; execute_worker ABSENT", () => {
  const yml = readFileSync(CONFIG_YML, "utf-8");
  assert.ok(yml.includes("execute_session.ts"), "execute_session.ts registered in customTools");
  assert.ok(!yml.includes("execute_worker.ts"), "execute_worker.ts must be absent from config");
  assert.ok(!existsSync(WORKER_SRC), "execute_worker.ts file must be deleted");
});

test("AGENTS.md: execute_session is default; no LEGACY execute_worker", () => {
  const md = readFileSync(AGENTS_MD, "utf-8");
  assert.match(md, /execute_session/, "mentions execute_session");
  assert.match(
    md,
    /Default path\s*=\s*\*\*`execute_session`\*\*|default path\s*=\s*\*\*`execute_session`\*\*|default\s*=\s*\*\*`execute_session`\*\*/i,
  );
  assert.doesNotMatch(md, /LEGACY[\s\S]{0,120}execute_worker/, "no LEGACY execute_worker paragraph");
  assert.doesNotMatch(md, /execute_worker\s*\(/, "no execute_worker call-site docs");
});
