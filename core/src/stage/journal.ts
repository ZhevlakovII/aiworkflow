/**
 * Stage journal (B1) — append-only NDJSON under `.workflow/stages/`.
 *
 * Path: `.workflow/stages/<ck12>.<stage>.ndjson` where ck12 = first 12 hex of
 * the contract-key (AD-contract-key-strip-plus-binder):
 *   - Normalize task-file bytes (UTF-8, LF newlines).
 *   - Before hash: strip frontmatter keys `id`, `supersedes`, `stage` only.
 *   - If `binds` is present: key = key of the bound design task after the same
 *     strip (one hop; not a free contract-id). Fail-closed on missing file,
 *     non-design target, cycle, or multiple/ambiguous binds.
 *   - Without `binds`: hash this file after strip.
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

import { frontmatter, scalar, scalarField } from "../design/task-zone.ts";

export const STAGES_DIR = ".workflow/stages";

/** Keys excluded from the contract-key hash (Design C + stage drift fix). */
const STRIP_FM_KEYS: Record<string, true> = {
  id: true,
  supersedes: true,
  stage: true,
};

/** Normalize task-file bytes for contract-key: UTF-8 text with LF newlines. */
export function normalizeTaskBytes(text: string): Buffer {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return Buffer.from(lf, "utf-8");
}

/** sha256 hex of normalized artifact bytes (same UTF-8/LF normalize as task-key). */
export function artifactHash(text: string): string {
  return createHash("sha256").update(normalizeTaskBytes(text)).digest("hex");
}

/**
 * Strip frontmatter `id`, `supersedes`, `stage` only. Body and other FM keys
 * (zone, class, binds, artifacts, …) stay. LF-normalize is applied at hash time.
 */
export function stripContractKeyFrontmatter(taskText: string): string {
  const lf = taskText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!lf.startsWith("---\n") && lf !== "---") return lf;
  const end = lf.indexOf("\n---", 4);
  if (end < 0) return lf;
  const fmBody = lf.slice(4, end);
  const afterCloser = lf.slice(end + "\n---".length);
  const kept = fmBody
    .split("\n")
    .filter((line) => {
      const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
      if (!m) return true;
      return !STRIP_FM_KEYS[m[1]!.toLowerCase()];
    })
    .join("\n");
  return "---\n" + kept + "\n---" + afterCloser;
}

export interface ContractKeyCtx {
  /** Absolute path of this task file (binds resolve relative to repoRoot). */
  taskPath?: string;
  /** Repo root / judge cwd — binds paths resolve here. */
  repoRoot?: string;
  exists?: (absPath: string) => boolean;
  readFile?: (absPath: string) => string;
}

export type ContractKeyOk = { ok: true; hex: string; ck12: string };
export type ContractKeyErr = { ok: false; error: string };
export type ContractKeyResult = ContractKeyOk | ContractKeyErr;

type BindsParse =
  | { kind: "none" }
  | { kind: "one"; target: string }
  | { kind: "multi" }
  | { kind: "empty" };

function parseBindsField(taskText: string): BindsParse {
  const fm = frontmatter(taskText);
  if (!fm) return { kind: "none" };
  if (!/^binds\s*:/m.test(fm)) return { kind: "none" };

  const flow = /^binds\s*:\s*\[([^\]]*)\]/m.exec(fm);
  if (flow) {
    const raw = flow[1] || "";
    const items: string[] = [];
    const re = /"([^"]+)"|'([^']+)'|([^,\s]+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(raw)) !== null) {
      const v = (mm[1] || mm[2] || mm[3] || "").trim();
      if (v) items.push(v);
    }
    if (items.length === 0) return { kind: "empty" };
    if (items.length > 1) return { kind: "multi" };
    return { kind: "one", target: items[0]! };
  }

  const blockIdx = fm.search(/^binds\s*:\s*$/m);
  if (blockIdx >= 0) {
    const after = fm.slice(blockIdx);
    const firstLineEnd = after.indexOf("\n");
    const rest = firstLineEnd >= 0 ? after.slice(firstLineEnd + 1) : "";
    const items: string[] = [];
    for (const line of rest.split("\n")) {
      if (!/^\s/.test(line) && line.trim() !== "") break;
      const im = /^\s+-\s+(.+?)\s*$/.exec(line);
      if (im) {
        let cleaned = im[1]!.replace(/\s+#\s.*$/, "").trim();
        if (cleaned.length >= 2) {
          const q0 = cleaned.charCodeAt(0);
          const q1 = cleaned.charCodeAt(cleaned.length - 1);
          if ((q0 === 34 && q1 === 34) || (q0 === 39 && q1 === 39)) {
            cleaned = cleaned.slice(1, -1);
          }
        }
        items.push(cleaned);
        continue;
      }
      if (line.trim() === "") continue;
      if (/^\s+/.test(line)) continue;
      break;
    }
    if (items.length === 0) return { kind: "empty" };
    if (items.length > 1) return { kind: "multi" };
    return { kind: "one", target: items[0]! };
  }

  const s = scalar(fm, "binds");
  if (s === undefined) return { kind: "none" };
  if (s.trim() === "") return { kind: "empty" };
  return { kind: "one", target: s.trim() };
}

function hashStripped(taskText: string): string {
  return createHash("sha256")
    .update(normalizeTaskBytes(stripContractKeyFrontmatter(taskText)))
    .digest("hex");
}

function isDesignStageText(taskText: string): boolean {
  const stage = (scalarField(taskText, "stage") || "").trim().toLowerCase();
  return stage.startsWith("design");
}

/**
 * Resolve contract-key (full hex + ck12). Fail-closed on bad binds.
 * One-hop binds only: target is hashed after strip; target binds are ignored.
 */
export function resolveContractKey(
  taskText: string,
  ctx: ContractKeyCtx = {},
): ContractKeyResult {
  const binds = parseBindsField(taskText);
  if (binds.kind === "multi") {
    return { ok: false, error: "contract-key binds: multiple targets (fail-closed)" };
  }
  if (binds.kind === "empty") {
    return { ok: false, error: "contract-key binds: empty (fail-closed)" };
  }
  if (binds.kind === "one") {
    const root = ctx.repoRoot ?? (ctx.taskPath ? path.dirname(ctx.taskPath) : undefined);
    if (!root) {
      return {
        ok: false,
        error: "contract-key binds: repoRoot/taskPath required to resolve (fail-closed)",
      };
    }
    const abs = path.resolve(root, binds.target);
    const norm = path.normalize(abs);
    const selfNorm = ctx.taskPath ? path.normalize(ctx.taskPath) : "";
    if (selfNorm && norm === selfNorm) {
      return { ok: false, error: "contract-key binds: cycle at " + binds.target + " (fail-closed)" };
    }
    const existsFn = ctx.exists ?? existsSync;
    const readFn = ctx.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    if (!existsFn(norm)) {
      return {
        ok: false,
        error: "contract-key binds: target not found: " + binds.target + " (fail-closed)",
      };
    }
    let targetText: string;
    try {
      targetText = readFn(norm);
    } catch {
      return {
        ok: false,
        error: "contract-key binds: target unreadable: " + binds.target + " (fail-closed)",
      };
    }
    if (!isDesignStageText(targetText)) {
      return {
        ok: false,
        error: "contract-key binds: target is not stage design*: " + binds.target + " (fail-closed)",
      };
    }
    const hex = hashStripped(targetText);
    return { ok: true, hex, ck12: hex.slice(0, 12) };
  }

  const hex = hashStripped(taskText);
  return { ok: true, hex, ck12: hex.slice(0, 12) };
}

/** Full sha256 hex of contract-key material. Throws ContractKeyError on binds failure. */
export function contractKeyHex(taskText: string, ctx?: ContractKeyCtx): string {
  const r = resolveContractKey(taskText, ctx);
  if (!r.ok) {
    const err = new Error(r.error);
    err.name = "ContractKeyError";
    throw err;
  }
  return r.hex;
}

/** First 12 hex chars of the contract-key (journal filename stem). */
export function contractKey12(taskText: string, ctx?: ContractKeyCtx): string {
  return contractKeyHex(taskText, ctx).slice(0, 12);
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
