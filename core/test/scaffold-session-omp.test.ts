/**
 * T4: OMP scaffold_session wiring (fixed scaffolder; no workers).
 * Task: .workflow/tasks/ports-omp-oc-scaffold-session.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const SESSION_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "scaffold_session.ts");
const WORKER_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "scaffold_worker.ts");
const CONFIG_YML = nodePath.join(REPO_ROOT, "ports", "omp", "config.yml");
const AGENTS_MD = nodePath.join(REPO_ROOT, "ports", "omp", "AGENTS.md");

test("scaffold_session.ts source must not contain claude exec or runWorker", () => {
  const src = readFileSync(SESSION_SRC, "utf-8");
  assert.match(src, /scaffold_session/, "tool file exists");
  assert.doesNotMatch(src, /\brunWorker\b/, "must not import/call runWorker");
  assert.doesNotMatch(src, /pi\.exec\(\s*["']claude["']/, "must not pi.exec(claude)");
  assert.doesNotMatch(src, /["']claude["']/, "must not reference claude binary/string");
  assert.match(src, /runJudgeCli/, "must reuse B1 judge");
  assert.match(src, /scaffold-begin/, "calls scaffold-begin");
  assert.match(src, /scaffold-done/, "calls scaffold-done");
  assert.match(src, /zoneCheck/, "must reuse zoneCheck");
  assert.match(src, /scaffolder/, "fixed scaffolder handoff");
  assert.doesNotMatch(src, /loadZoneMap|resolveAgent/, "no zonemap domain resolve");
  assert.match(src, /active-zone\.json/, "writes worker zone file");
});

test("config.yml registers scaffold_session; scaffold_worker ABSENT", () => {
  const yml = readFileSync(CONFIG_YML, "utf-8");
  assert.ok(yml.includes("scaffold_session.ts"), "scaffold_session.ts registered in customTools");
  assert.ok(!yml.includes("scaffold_worker.ts"), "scaffold_worker.ts must be absent from config");
  assert.ok(!existsSync(WORKER_SRC), "scaffold_worker.ts file must be deleted/absent");
});

test("AGENTS.md: scaffold_session is default; no LEGACY scaffold_worker", () => {
  const md = readFileSync(AGENTS_MD, "utf-8");
  assert.match(md, /scaffold_session/, "mentions scaffold_session");
  assert.match(
    md,
    /Default path\s*=\s*\*\*`scaffold_session`\*\*|default path\s*=\s*\*\*`scaffold_session`\*\*|default\s*=\s*\*\*`scaffold_session`\*\*/i,
  );
  assert.doesNotMatch(md, /LEGACY[\s\S]{0,120}scaffold_worker/, "no LEGACY scaffold_worker paragraph");
  assert.doesNotMatch(md, /scaffold_worker\s*\(/, "no scaffold_worker call-site docs");
});


test("scaffold_session: lever off + resolveContractKey + MISROUTE", () => {
  const src = readFileSync(SESSION_SRC, "utf-8");
  assert.match(src, /scaffoldOptInFromTaskText/, "reads scaffold lever");
  assert.match(src, /lever is off|scaffold lever/, "errs when lever off");
  assert.match(src, /no done fabricate|no fake|lever is off/);
  assert.match(src, /resolveContractKey/, "shared contract key");
  assert.match(src, /MISROUTE/);
  assert.match(src, /scaffold/);
});

