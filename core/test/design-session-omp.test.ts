/**
 * B2a/B4: OMP design_session wiring + workers retired.
 * Task: .workflow/tasks/b4-delete-drivers.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const SESSION_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "design_session.ts");
const WORKER_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "design_worker.ts");
const CONFIG_YML = nodePath.join(REPO_ROOT, "ports", "omp", "config.yml");
const AGENTS_MD = nodePath.join(REPO_ROOT, "ports", "omp", "AGENTS.md");

test("design_session.ts source must not contain claude exec or runWorker", () => {
  const src = readFileSync(SESSION_SRC, "utf-8");
  assert.match(src, /design_session/, "tool file exists");
  assert.doesNotMatch(src, /\brunWorker\b/, "must not import/call runWorker");
  assert.doesNotMatch(src, /pi\.exec\(\s*["']claude["']/, "must not pi.exec(claude)");
  assert.doesNotMatch(src, /["']claude["']/, "must not reference claude binary/string");
  assert.match(src, /runJudgeCli/, "must reuse B1 judge");
  assert.match(src, /gateLint/, "must reuse gateLint");
});

test("config.yml registers design_session; design_worker ABSENT", () => {
  const yml = readFileSync(CONFIG_YML, "utf-8");
  assert.ok(yml.includes("design_session.ts"), "design_session.ts registered in customTools");
  assert.ok(!yml.includes("design_worker.ts"), "design_worker.ts must be absent from config");
  assert.ok(!existsSync(WORKER_SRC), "design_worker.ts file must be deleted");
});

test("AGENTS.md: design_session is default; no LEGACY design_worker", () => {
  const md = readFileSync(AGENTS_MD, "utf-8");
  assert.match(md, /design_session/, "mentions design_session");
  assert.match(
    md,
    /Default path\s*=\s*\*\*`design_session`\*\*|default path\s*=\s*\*\*`design_session`\*\*|default\s*=\s*\*\*`design_session`\*\*/i,
  );
  assert.doesNotMatch(md, /LEGACY[\s\S]{0,120}design_worker/, "no LEGACY design_worker paragraph");
  assert.doesNotMatch(md, /design_worker\s*\(/, "no design_worker call-site docs");
});
