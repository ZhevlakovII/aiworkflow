// fr-trace (P9 B.1b) — детерминир. FR↔test traceability-гейт.
// Каждый FR-* из change-spec ДОЛЖЕН упоминаться в ≥1 staged тест-файле (по FR-id как токену).
// Enforcement > инструкция (проект-тезис): execute_worker велит воркеру покрыть FR тестом, но реально
// это гарантирует ЭТОТ гейт, не послушность модели. FR УСЛОВЕН (как B.1a): 0 FR → PASS (мета/констрейнт-задача).
// Механика (id-токен в тест-файле), НЕ семантика («тот ли тест») — семантика на critic/ревью.
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

/** FR-id'ы из spec-файла (```fr блоки). */
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

/** Файл — тест? (по basename-эвристике; kotlin/py/ts/go). */
export function isTestFile(p: string): boolean {
  return TEST_BASENAME_RE.test(path.basename(p));
}

/**
 * Гейт: каждый FR-id покрыт (упомянут как подстрока) в каком-то из testFiles.
 * repoRoot нужен чтобы читать содержимое relative-путей testFiles.
 * 0 FR → пустые findings (условен). FR>0 && нет тест-файлов → finding.
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
