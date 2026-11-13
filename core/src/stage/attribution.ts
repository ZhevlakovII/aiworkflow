/**
 * B3 / B3.1 — design-artifact attribution for L1 (gatedCommit).
 *
 * Index: path → {ck12, locked:true, …} from `.workflow/stages/*.design.ndjson`
 * journals that carry a `design-lock` event. Fail-closed (when
 * `policy.stage.attribution_fail_closed`): new unattributed template files
 * are refused; HEAD files without an owner are grandfathered.
 *
 * B3.1: hash-binding (specHash/adrHash on lock) + gateLint recount on L1
 * for attributed staged artifacts (journal PASS is not trusted).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { gateLint } from "../design/gate-lint.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import type { GitSeam } from "../rails/git-seam.ts";
import { artifactHash, STAGES_DIR, type StageJournalEvent } from "./journal.ts";

export interface AttributionOwner {
  ck12: string;
  locked: true;
  taskRel?: string;
  spec?: string;
  adr?: string;
  specHash?: string;
  adrHash?: string;
}

export type AttributionIndex = Map<string, AttributionOwner>;

export interface DesignArtifacts {
  tid: string;
  outDir: string;
  /** Posix relative path of the spec artifact. */
  spec: string;
  /** Posix relative path of the ADR artifact. */
  adr: string;
}

export interface AttributionFs {
  exists(p: string): boolean;
  readFile(p: string): string;
  readdir(p: string): string[];
}

const DEFAULT_FS: AttributionFs = {
  exists: existsSync,
  readFile: (p) => readFileSync(p, "utf-8"),
  readdir: (p) => readdirSync(p),
};

/** Normalize to posix rel without leading `./`. */
export function toPosixRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Design artifact template: posix rel under `docs/design/`, basename matches
 * `*-spec.md` or `*-adr.md`.
 */
export function isDesignArtifact(rel: string): boolean {
  const posix = toPosixRel(rel);
  if (!posix.startsWith("docs/design/") || posix === "docs/design/") return false;
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  return /^.+-(spec|adr)\.md$/.test(base);
}

function taskFrontmatterOrWhole(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("---", 3);
  if (end < 0) return text;
  return text.slice(3, end);
}

function scalarWithComment(fm: string, key: string): string {
  const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(fm);
  if (!m) return "";
  return (m[1] as string).replace(/\s+#\s.*$/, "").trim();
}

/**
 * Artifact paths for a contract (same shape as design-stage parseTask, with
 * B3's "first non-`.workflow` allow glob" rule).
 */
export function artifactsFromTask(taskText: string, taskStem: string): DesignArtifacts {
  const fm = taskFrontmatterOrWhole(taskText);
  const tid = scalarWithComment(fm, "id") || taskStem;

  const m = /allow:\s*\[([^\]]*)\]/.exec(fm);
  const items: string[] = [];
  if (m) {
    const re = /["']([^"']+)["']/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(m[1] as string)) !== null) items.push(mm[1] as string);
  }

  let allow0 = "";
  for (const item of items) {
    const posix = toPosixRel(item);
    if (posix === ".workflow" || posix.startsWith(".workflow/")) continue;
    allow0 = posix;
    break;
  }

  const outDir =
    allow0.replace(/\/\*\*/g, "").replace(/\/\*/g, "").replace(/\/+$/, "").trim() || "docs/design";
  const spec = `${outDir}/${tid}-spec.md`;
  const adr = `${outDir}/${tid}-adr.md`;
  return { tid, outDir, spec, adr };
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
      // skip malformed
    }
  }
  return events;
}

function lastOfType(events: StageJournalEvent[], type: string): StageJournalEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === type) return events[i];
  }
  return undefined;
}

function resolveArtifactsForJournal(
  repoRoot: string,
  events: StageJournalEvent[],
  fs: AttributionFs,
): { spec: string; adr: string } | undefined {
  const lock = lastOfType(events, "design-lock");
  if (!lock) return undefined;

  const lockSpec = typeof lock.spec === "string" ? toPosixRel(lock.spec) : "";
  const lockAdr = typeof lock.adr === "string" ? toPosixRel(lock.adr) : "";
  if (lockSpec && lockAdr) {
    return { spec: lockSpec, adr: lockAdr };
  }

  const begin = lastOfType(events, "design-begin");
  const taskRel = typeof begin?.task === "string" ? begin.task : "";
  if (!taskRel) return undefined;
  const taskAbs = path.join(repoRoot, taskRel);
  if (!fs.exists(taskAbs)) return undefined;
  try {
    const taskText = fs.readFile(taskAbs);
    const stem = path.basename(taskRel, path.extname(taskRel));
    const arts = artifactsFromTask(taskText, stem);
    return { spec: arts.spec, adr: arts.adr };
  } catch {
    return undefined;
  }
}

/**
 * Scan `.workflow/stages/*.design.ndjson`. For journals with a design-lock,
 * map spec+adr → `{ck12, locked:true, …hashes/taskRel}`. Last lock wins on
 * path collision.
 */
export function buildAttributionIndex(
  repoRoot: string,
  fs: AttributionFs = DEFAULT_FS,
): AttributionIndex {
  const index: AttributionIndex = new Map();
  const stagesAbs = path.join(repoRoot, STAGES_DIR);
  if (!fs.exists(stagesAbs)) return index;

  let names: string[];
  try {
    names = fs.readdir(stagesAbs);
  } catch {
    return index;
  }

  // Stable order so "last lock wins" is deterministic across platforms.
  names = names.filter((n) => n.endsWith(".design.ndjson")).sort();

  for (const name of names) {
    const ck12 = name.slice(0, -".design.ndjson".length);
    if (!ck12) continue;
    const abs = path.join(stagesAbs, name);
    let text: string;
    try {
      text = fs.readFile(abs);
    } catch {
      continue;
    }
    const events = parseJournalLines(text);
    const arts = resolveArtifactsForJournal(repoRoot, events, fs);
    if (!arts) continue;

    const lock = lastOfType(events, "design-lock")!;
    const begin = lastOfType(events, "design-begin");
    const taskRel = typeof begin?.task === "string" ? toPosixRel(begin.task) : undefined;

    const owner: AttributionOwner = {
      ck12,
      locked: true,
      spec: arts.spec,
      adr: arts.adr,
    };
    if (taskRel) owner.taskRel = taskRel;
    if (typeof lock.specHash === "string") owner.specHash = lock.specHash;
    if (typeof lock.adrHash === "string") owner.adrHash = lock.adrHash;

    index.set(arts.spec, owner);
    index.set(arts.adr, owner);
  }
  return index;
}

/** `git cat-file -e HEAD:<posix-path>` — code 0 means the path is in HEAD. */
export function inHEAD(git: GitSeam, rel: string): boolean {
  const posix = toPosixRel(rel);
  return git.run(["git", "cat-file", "-e", `HEAD:${posix}`]).code === 0;
}

export type AttributionVerdict =
  | { ok: true }
  | { ok: false; status: "attribution-denied"; detail: string };

/**
 * L1 check: when fail-closed is on, each staged design artifact must be
 * owned by a locked journal entry; new unattributed files are refused;
 * HEAD without owner is grandfathered. Owned artifacts additionally get
 * hash-binding (when hashes present) and gateLint recount (when task+files
 * exist).
 */
export function evaluateStagedAttribution(options: {
  staged: readonly string[];
  policy: ResolvedPolicy;
  git: GitSeam;
  repoRoot: string;
  /** Injected index (tests); absent → built from disk under repoRoot. */
  index?: AttributionIndex;
  fs?: AttributionFs;
}): AttributionVerdict {
  if (!options.policy.stage?.attribution_fail_closed) {
    return { ok: true };
  }

  const fs = options.fs ?? DEFAULT_FS;
  const index = options.index ?? buildAttributionIndex(options.repoRoot, fs);
  const gateDone = new Set<string>();

  for (const raw of options.staged) {
    const rel = toPosixRel(raw);
    if (!isDesignArtifact(rel)) continue;

    const owner = index.get(rel);
    if (!owner || !owner.locked) {
      if (inHEAD(options.git, rel)) {
        // Grandfather: existing HEAD path without owner.
        continue;
      }
      return {
        ok: false,
        status: "attribution-denied",
        detail: `${rel}: no design-lock owner in journal index`,
      };
    }

    // Hash binding — only when lock recorded hashes (pre-B3.1 journals skip).
    const expectedHash =
      owner.spec && rel === owner.spec
        ? owner.specHash
        : owner.adr && rel === owner.adr
          ? owner.adrHash
          : undefined;
    if (typeof expectedHash === "string") {
      const abs = path.join(options.repoRoot, rel);
      if (!fs.exists(abs)) {
        return {
          ok: false,
          status: "attribution-denied",
          detail: `${rel}: missing after lock (hash-bound)`,
        };
      }
      let current: string;
      try {
        current = artifactHash(fs.readFile(abs));
      } catch {
        return {
          ok: false,
          status: "attribution-denied",
          detail: `${rel}: unreadable after lock (hash-bound)`,
        };
      }
      if (current !== expectedHash) {
        return {
          ok: false,
          status: "attribution-denied",
          detail: `${rel}: hash mismatch (tamper)`,
        };
      }
    }

    // Gate recount once per ck12 when task + artifacts exist.
    if (owner.taskRel && owner.spec && !gateDone.has(owner.ck12)) {
      const taskAbs = path.join(options.repoRoot, owner.taskRel);
      const specAbs = path.join(options.repoRoot, owner.spec);
      if (!fs.exists(taskAbs) || !fs.exists(specAbs)) {
        // skip recount until files present
      } else if (!owner.adr) {
        // spec-roadmap lock: recount source↔spec only
        gateDone.add(owner.ck12);
        const g = gateLint(taskAbs, specAbs, null, options.repoRoot, {
          generation: "spec-roadmap",
        });
        if (g.findings.length > 0) {
          return {
            ok: false,
            status: "attribution-denied",
            detail: `${rel}: gate recount (${g.findings.length}): ${g.findings.join("; ")}`,
          };
        }
      } else {
        const adrAbs = path.join(options.repoRoot, owner.adr);
        if (fs.exists(adrAbs)) {
          gateDone.add(owner.ck12);
          const g = gateLint(taskAbs, specAbs, adrAbs, options.repoRoot);
          if (g.findings.length > 0) {
            return {
              ok: false,
              status: "attribution-denied",
              detail: `${rel}: gate recount (${g.findings.length}): ${g.findings.join("; ")}`,
            };
          }
        }
      }
    }
  }

  return { ok: true };
}
