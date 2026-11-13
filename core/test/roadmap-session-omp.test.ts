/**
 * Phase 1: OMP roadmap_session wiring (fixed roadmapper; generation gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const SESSION_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "roadmap_session.ts");
const SCAFFOLD_SRC = nodePath.join(REPO_ROOT, "ports", "omp", "tools", "scaffold_session.ts");
const AGENTS_MD = nodePath.join(REPO_ROOT, "ports", "omp", "AGENTS.md");

test("roadmap_session.ts: judge + zoneCheck + roadmapper; no model spawn", () => {
  const src = readFileSync(SESSION_SRC, "utf-8");
  assert.match(src, /roadmap_session/, "tool file exists");
  assert.doesNotMatch(src, /\brunWorker\b/, "must not import/call runWorker");
  assert.doesNotMatch(src, /pi\.exec\(\s*["']claude["']/, "must not pi.exec(claude)");
  assert.match(src, /runJudgeCli/, "must reuse B1 judge");
  assert.match(src, /roadmap-begin/, "calls roadmap-begin");
  assert.match(src, /roadmap-done/, "calls roadmap-done");
  assert.match(src, /zoneCheck/, "must reuse zoneCheck");
  assert.match(src, /roadmapper/, "fixed roadmapper handoff");
  assert.doesNotMatch(src, /loadZoneMap|resolveAgent/, "no zonemap domain resolve");
  assert.match(src, /active-zone\.json/, "writes worker zone file");
  assert.match(src, /isSpecRoadmapGeneration/, "generation gate");
  assert.match(src, /MISROUTE/);
});

test("scaffold_session refuses generation=spec-roadmap", () => {
  const src = readFileSync(SCAFFOLD_SRC, "utf-8");
  assert.match(src, /isSpecRoadmapGeneration/);
  assert.match(src, /scaffold_session refused|scaffold retired/);
});

test("AGENTS.md: roadmap_session default mid; scaffolder not default mid", () => {
  const md = readFileSync(AGENTS_MD, "utf-8");
  assert.match(md, /roadmap_session/, "mentions roadmap_session");
  assert.match(md, /roadmapper/);
  assert.match(
    md,
    /Default path\s*=\s*\*\*`roadmap_session`\*\*|default path\s*=\s*\*\*`roadmap_session`\*\*/i,
  );
  assert.match(md, /generation:\s*spec-roadmap|generation.*spec-roadmap/i);
  assert.match(md, /retired|не default mid|not default mid/i);
});
