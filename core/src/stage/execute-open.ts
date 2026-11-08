/**
 * Execute-stage open probe — Design C AD-session-write-protected-set
 * (execute-stage lead freeze). True when any `.workflow/stages/*.execute.ndjson`
 * folds chronologically to an unmatched `exec-started` (no later `exec-done`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { STAGES_DIR, type StageJournalEvent } from "./journal.ts";

const EXEC_STARTED = "exec-started";
const EXEC_DONE = "exec-done";
const EXECUTE_SUFFIX = ".execute.ndjson";

export interface ExecuteOpenDeps {
  exists?(p: string): boolean;
  readdir?(p: string): string[];
  readFile?(p: string): string;
}

function parseJournalLines(text: string): StageJournalEvent[] {
  const events: StageJournalEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.type === "string") {
          events.push(obj as StageJournalEvent);
        }
      }
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/** Fold events in order: exec-started opens, exec-done closes. */
export function foldExecuteOpen(events: readonly StageJournalEvent[]): boolean {
  let open = false;
  for (const e of events) {
    if (e.type === EXEC_STARTED) open = true;
    else if (e.type === EXEC_DONE) open = false;
  }
  return open;
}

/**
 * True iff any execute journal under `.workflow/stages/` is chronologically
 * open (exec-started with no later exec-done). Missing stages dir / empty
 * journals → false.
 */
export function anyOpenExecuteStage(repoRoot: string, deps?: ExecuteOpenDeps): boolean {
  const exists = deps?.exists ?? existsSync;
  const readdir = deps?.readdir ?? ((p: string) => readdirSync(p));
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

  const stagesAbs = path.join(repoRoot, STAGES_DIR);
  if (!exists(stagesAbs)) return false;

  let names: string[];
  try {
    names = readdir(stagesAbs);
  } catch {
    return false;
  }

  for (const name of names) {
    if (!name.endsWith(EXECUTE_SUFFIX)) continue;
    const abs = path.join(stagesAbs, name);
    let text: string;
    try {
      text = readFile(abs);
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    if (foldExecuteOpen(parseJournalLines(text))) return true;
  }
  return false;
}
