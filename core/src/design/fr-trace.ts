/**
 * fr-trace (T7-3) — TS port (promoted to core, single implementation) of
 * `tools/fr_trace.py` / former `.omp/tools/_lib/frtrace.ts` (P9 B.1b).
 * Deterministic FR<->test traceability-gate.
 *
 * Every FR-* from a change-spec MUST be mentioned in >=1 staged test-file
 * (as an FR-id token). Enforcement > instruction (project thesis):
 * execute_worker tells the worker to cover an FR with a test, but THIS gate
 * is what actually guarantees it, not model obedience. FR is CONDITIONAL
 * (like B.1a): 0 FR -> PASS (meta/constraint task). Mechanical (id-token in
 * a test-file), NOT semantic ("is it the right test") — semantics is a
 * critic/review concern.
 *
 * Pure `frTrace(...)` — the thin CLI shell lives in `./fr-trace-cli.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const FR_ID_RE = /```fr\s*\n([\s\S]*?)```/g;
const ID_LINE_RE = /^\s*id:\s*(\S+)/m;
// тест-файл по basename: содержит test/spec (kotlin `FooTest.kt`, py `test_foo.py`, ts `foo.test.ts`).
const TEST_BASENAME_RE = /(^test[_.]|[._-]?test[s]?[._]|spec[._]|[._]spec\.|Test\.|Tests\.)/i;

export interface FrTraceResult {
  findings: string[];
  frIds: string[];
  covered: string[];
  testFiles: string[];
}

/** FR-ids from a spec-file (```fr blocks). */
export function frIdsFromSpec(specPath: string): string[] {
  if (!fs.existsSync(specPath)) return [];
  const text = fs.readFileSync(specPath, "utf8");
  const ids: string[] = [];
  for (const m of text.matchAll(FR_ID_RE)) {
    const im = ID_LINE_RE.exec(m[1]);
    if (im) ids.push(im[1]);
  }
  return ids;
}

/** Is the file a test? (basename heuristic; kotlin/py/ts/go.) */
export function isTestFile(p: string): boolean {
  return TEST_BASENAME_RE.test(path.basename(p));
}

/**
 * Gate: every FR-id is covered (mentioned as a substring) in some testFile.
 * repoRoot is used to read relative testFiles' content.
 * 0 FR -> empty findings (conditional). FR>0 && no test-files -> a finding.
 */
export function frTrace(specPath: string, stagedFiles: string[], repoRoot: string): FrTraceResult {
  const frIds = frIdsFromSpec(specPath);
  const testFiles = stagedFiles.filter(isTestFile);
  if (!frIds.length) return { findings: [], frIds, covered: [], testFiles };

  const findings: string[] = [];
  if (!testFiles.length)
    findings.push(`FR-trace: ${frIds.length} FR в spec, но ни одного тест-файла в staged (покрой FR тестом)`);

  const blob = testFiles
    .map((f) => { try { return fs.readFileSync(path.resolve(repoRoot, f), "utf8"); } catch { return ""; } })
    .join("\n");
  const covered: string[] = [];
  for (const id of frIds) {
    if (blob.includes(id)) covered.push(id);
    else if (testFiles.length) findings.push(`FR-trace: ${id} не упомянут ни в одном тест-файле (не трассируется)`);
  }
  return { findings, frIds, covered, testFiles };
}
