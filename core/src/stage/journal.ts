/**
 * Stage journal (B1) — append-only NDJSON under `.workflow/stages/`.
 *
 * Path: `.workflow/stages/<ck12>.<stage>.ndjson` where ck12 = first 12 hex of
 * sha256 of normalized task-file bytes (UTF-8, LF newlines — contract
 * `.workflow/tasks/b1-judge-minimum.md`).
 *
 * Stages: `design` (B1: design-begin/gate/critic/lock); `scaffold`
 * (`scaffold-started`, `scaffold-done` with outcome ok|violation);
 * `execute` (B2b: `exec-started`, `exec-done` with outcome ok|violation).
 *
 * Convention: only the judge module writes; these helpers are pure fs
 * functions exported for that use (and tests).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const STAGES_DIR = ".workflow/stages";

/** Normalize task-file bytes for contract-key: UTF-8 text with LF newlines. */
export function normalizeTaskBytes(text: string): Buffer {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return Buffer.from(lf, "utf-8");
}

/** sha256 hex of normalized artifact bytes (same UTF-8/LF normalize as task-key). */
export function artifactHash(text: string): string {
  return createHash("sha256").update(normalizeTaskBytes(text)).digest("hex");
}

/** Full sha256 hex of normalized task-file bytes. */
export function contractKeyHex(taskText: string): string {
  return createHash("sha256").update(normalizeTaskBytes(taskText)).digest("hex");
}

/** First 12 hex chars of the contract-key (journal filename stem). */
export function contractKey12(taskText: string): string {
  return contractKeyHex(taskText).slice(0, 12);
}

export function journalRelPath(contractKey: string, stage: string): string {
  const ck12 = contractKey.length >= 12 ? contractKey.slice(0, 12) : contractKey;
  return path.posix.join(STAGES_DIR, `${ck12}.${stage}.ndjson`);
}

export function journalAbsPath(repoRoot: string, contractKey: string, stage: string): string {
  return path.join(repoRoot, journalRelPath(contractKey, stage));
}

export type StageJournalEvent = Record<string, unknown> & {
  type: string;
  ts?: string;
};

/**
 * Append one JSON event (single line) to the stage journal. Creates the
 * stages directory if missing. Does not rewrite prior lines (append-only).
 */
export function appendEvent(
  repoRoot: string,
  contractKey: string,
  stage: string,
  event: StageJournalEvent,
): string {
  const abs = journalAbsPath(repoRoot, contractKey, stage);
  mkdirSync(path.dirname(abs), { recursive: true });
  const withTs: StageJournalEvent = {
    ts: event.ts ?? new Date().toISOString(),
    ...event,
  };
  // Ensure type wins if caller also put type after ts spread edge-cases.
  withTs.type = event.type;
  appendFileSync(abs, JSON.stringify(withTs) + "\n", "utf-8");
  return abs;
}

/**
 * Read all parseable events from a stage journal. Missing file -> [].
 * Malformed lines are skipped (fail-soft read; writer is trusted judge).
 */
export function readJournal(
  repoRoot: string,
  contractKey: string,
  stage: string,
): StageJournalEvent[] {
  const abs = journalAbsPath(repoRoot, contractKey, stage);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, "utf-8");
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
