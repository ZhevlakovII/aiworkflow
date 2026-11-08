/**
 * audit-commits core (T7-5, contract L-1/L-3) — pure TS port of
 * `tools/audit_commits.py`'s classification logic: bypass-scan over `git
 * log` output — commits WITHOUT a rail-signature (`[omp-rail:<tool>]`
 * trailer, or a legacy pattern) are "suspect" (potential bypass of the
 * commit/design rails).
 *
 * T7-6 (contract L-1): the former gap is CLOSED — `core/src/rails/commit.ts`
 * (`gatedCommit`) and `core/src/rails/merge.ts` (`gatedMerge`) now append
 * `[omp-rail:commit]` / `[omp-rail:merge]` trailers themselves (unless the
 * message already carries one), so `/aiwf-commit`/`/aiwf-merge` output is
 * classified as rail-signed here, not bypass-suspected. This RAIL regex
 * still needs no changes — it already matches any `[omp-rail:<tool>]`.
 * `core/src/design/design-stage.ts` (LEGACY pattern
 * `design(<tid>): spec+ADR locked`) and `tools/queue_batch.ts` (explicit
 * `[omp-rail:queue_batch]` trailer) continue to auto-sign their commits.
 * A commit is STILL "suspect" only when made outside every rail (raw
 * `git commit`, by design — per the Python original's docstring: "в
 * human-репо это нормальные ручные коммиты, читать с суждением").
 */

export interface CommitLogEntry {
  sha: string;
  author: string;
  subject: string;
  body: string;
}

export interface SuspectEntry {
  sha: string;
  author: string;
  subject: string;
}

export interface AuditResult {
  total: number;
  signedCount: number;
  suspect: SuspectEntry[];
}

const RAIL = /\[omp-rail:/;
const LEGACY = /via (execute|codex)_worker|^design\([^)]+\): spec\+ADR locked/i;

/** git-log `--format="%H%x00%an%x00%s%x00%b%x1e"` output -> commit rows (NUL-split fields, RS-split records — same escapes the Python original uses to keep NUL/RS out of subprocess argv on Windows). */
export function parseGitLog(raw: string): CommitLogEntry[] {
  const NUL = "\u0000";
  const REC = "\u001e";
  const commits: CommitLogEntry[] = [];
  for (const chunk of raw.split(REC)) {
    const rec = chunk.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!rec.trim()) continue;
    const parts = rec.split(NUL);
    if (parts.length < 4) continue;
    commits.push({ sha: parts[0].slice(0, 9), author: parts[1], subject: parts[2], body: parts[3] });
  }
  return commits;
}

export function classifyCommits(commits: readonly CommitLogEntry[]): AuditResult {
  let signedCount = 0;
  const suspect: SuspectEntry[] = [];
  for (const c of commits) {
    const text = `${c.subject}\n${c.body}`;
    if (RAIL.test(text) || LEGACY.test(text)) {
      signedCount++;
    } else {
      suspect.push({ sha: c.sha, author: c.author, subject: c.subject });
    }
  }
  return { total: commits.length, signedCount, suspect };
}

export interface GuardRow {
  ts: string;
  kind: "guard";
  event: "bypass-suspected";
  tool: "audit_commits";
  detail: string;
}

export function buildGuardRow(sha: string, subject: string, nowIso: string): GuardRow {
  return { ts: nowIso, kind: "guard", event: "bypass-suspected", tool: "audit_commits", detail: `${sha} ${subject.slice(0, 120)}` };
}

function ljust(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function renderText(r: AuditResult): string {
  const lines = [`== BYPASS AUDIT == total=${r.total} rail-signed=${r.signedCount} suspect=${r.suspect.length}`];
  if (r.suspect.length) {
    lines.push("-- НЕ через рельс (bypass-suspected / ручные) --");
    for (const c of r.suspect) lines.push(`  ${c.sha}  ${ljust(c.author, 12)}  ${c.subject.slice(0, 80)}`);
  } else {
    lines.push("  все коммиты несут rail-подпись ✓");
  }
  return lines.join("\n");
}

export function renderJson(r: AuditResult): { total: number; signed: number; suspect: SuspectEntry[] } {
  return { total: r.total, signed: r.signedCount, suspect: r.suspect };
}
