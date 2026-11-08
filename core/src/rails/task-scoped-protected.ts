/**
 * A2 (U13) — task-scoped exception to `operator_zone.protected` in the L1
 * commit rail (contract `.workflow/tasks/a2-u13-task-scoped-protected.md`).
 *
 * Without this module `gatedCommit` (`./commit.ts`) refuses EVERY staged path
 * under a `policy.operator_zone.protected` root (e.g. `.omp/**`) unconditionally
 * (`classifyPath`, actor `"operator"`) — even while a worker is legitimately
 * executing a task whose OWN task-file explicitly grants that path (U13's
 * real-world trigger: `.omp/agents/*.md` edits could only ever be committed by
 * a human). This module lets `commit.ts` waive that ONE deny, per staged path,
 * ONLY when ALL three conditions hold (contract §Требуется, п.1):
 *  a) a valid active worker zone exists (`.workflow/active-zone.json`, T8 H2 —
 *     `commit.ts` passes it in as `workerZone`/`workerZoneTask`);
 *  b) the task-file `.workflow/tasks/<workerZoneTask>.md` parses (frontmatter,
 *     `zone.allow`) and contains a glob EXPLICITLY rooted at the matched
 *     protected root (`<protected>/...`, e.g. `.omp/agents/**` — a bare `**`/
 *     `*` glob does NOT count, contract "широкие ** /* не считаются явным
 *     разрешением") that matches the path, and no `zone.deny` glob matches it;
 *  c) the path is covered by the active zone's OWN `allow` and not its `deny`.
 * `.git` / `DEFAULT_PROTECTED` are NEVER eligible (contract "NOT .git") — this
 * module only ever considers entries from `policy.operator_zone.protected`.
 *
 * Fail-closed (contract §Требуется, п.2): any condition NOT met -> the ORIGINAL
 * deny stands, `kind: "denied"`, reason names the missing condition. Task-file
 * absent / unreadable / no frontmatter / `zone` not a block / `zone.allow`
 * missing -> `status: "zone-invalid"` (never a silent pass). No active zone at
 * all -> exception not attempted (condition a fails first, same status/shape
 * as the pre-existing `zone-violation`).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { normalizePath, pathMatches } from "../classify/path-zone.ts";
import { DEFAULT_PROTECTED } from "../classify/rules.ts";
import { frontmatter } from "../design/task-zone.ts";
import { isValidTaskId } from "./active-zone.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import type { ZoneOptions } from "../classify/classify.ts";

/**
 * Same bare-directory-name expansion as `path-zone.ts`'s private
 * `expandProtectedEntry` (not exported — contract "reuse pathMatches/
 * globToRegExp", this tiny transform is re-derived, not imported, to avoid
 * touching `core/src/classify/**`, out of this task's allow-zone). A plain
 * entry (no glob metacharacter) means "the dir and everything under it".
 */
function expandBareEntries(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => {
    if (/[*?]/.test(entry)) return [entry];
    const trimmed = entry.replace(/\/+$/, "");
    return [trimmed, `${trimmed}/**`];
  });
}

interface TaskFileZoneOk {
  ok: true;
  allow: string[];
  deny: string[];
}
interface TaskFileZoneInvalid {
  ok: false;
  reason: string;
}
type TaskFileZoneLoad = TaskFileZoneOk | TaskFileZoneInvalid;

/** `"a", "b"` -> `["a", "b"]` — same quoted-string extraction as the shared `globList`. */
function extractQuotedList(inner: string): string[] {
  return Array.from(inner.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
}

/**
 * Security review (A2/U13 follow-up): the shared `globList` (`../design/
 * task-zone.ts`) matches `` `${key}:\s*\[...\]` `` with NO line/position
 * anchor anywhere in the WHOLE frontmatter text — a task-file line like
 * `reallow: [...]` (or one appearing before/outside the `zone:` block
 * entirely) would silently satisfy it. This module instead requires the
 * `allow`/`deny` key to be its OWN line (`^[ \t]+allow:`/`deny:`, anchored),
 * strictly INSIDE the indented block that immediately follows the `zone:`
 * line — never a substring match, never a line outside that block. A
 * duplicate `allow`/`deny` key within the block, or any shape this cannot
 * confidently parse (block-style multi-line list, missing brackets, ...) ->
 * fail-closed `null` (caller reports `zone.allow`/`zone.deny` missing).
 */
function extractZoneBlockLists(fm: string): { allow: string[] | null; deny: string[] | null; ok: true } | { ok: false; reason: string } {
  const lines = fm.split(/\r?\n/);
  const zoneLineIdx = lines.findIndex((l) => /^zone:[ \t]*$/.test(l));
  if (zoneLineIdx === -1) return { ok: false, reason: "внутренняя ошибка: zone-блок не найден" };

  let allow: string[] | null = null;
  let deny: string[] | null = null;
  for (let i = zoneLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // tolerate a blank line inside the block
    if (!/^[ \t]/.test(line)) break; // next top-level frontmatter key (or end) -> block over

    const allowMatch = line.match(/^[ \t]+allow:[ \t]*\[(.*)\][ \t]*$/);
    if (allowMatch) {
      if (allow !== null) return { ok: false, reason: "дублирующийся ключ `allow` в zone-блоке" };
      allow = extractQuotedList(allowMatch[1]);
      continue;
    }
    const denyMatch = line.match(/^[ \t]+deny:[ \t]*\[(.*)\][ \t]*$/);
    if (denyMatch) {
      if (deny !== null) return { ok: false, reason: "дублирующийся ключ `deny` в zone-блоке" };
      deny = extractQuotedList(denyMatch[1]);
      continue;
    }
    // Any other nested key inside the block (test-cmd, gate-optional, ...) — ignored, not our concern here.
  }
  return { ok: true, allow, deny };
}

/**
 * Load + validate `.workflow/tasks/<task>.md`'s `zone.allow`/`zone.deny`
 * (contract §Требуется п.2, fail-closed on every distinguishable failure —
 * missing file / unreadable / no frontmatter / `zone` not a block / no
 * `zone.allow`). Reuses `frontmatter` (`../design/task-zone.ts`, the
 * existing task-file `--- ... ---` extractor — contract "search before
 * writing a new one") but NOT its `globList` (see `extractZoneBlockLists`
 * doc-comment — unanchored, substring-matchable, a security review finding).
 *
 * `task` is re-validated here defensively (`isValidTaskId`, `./active-zone.ts`
 * — same rule `parseActiveZone` already enforces on `active-zone.json`'s
 * `task` field) even though every real caller already goes through that
 * gate: this function's own `path.join` must never trust a single upstream
 * check alone (defence in depth). The resolved path is ALSO asserted to stay
 * inside `<repoRoot>/.workflow/tasks/` as a second, independent guard.
 *
 * Exported (A5a) so `./task-gate.ts` reuses this SAME strict frontmatter/
 * zone-block parse + id-validation for the L1 commit rail's task-scoped gate
 * resolution — no second, drifting copy of the parser (contract "тот же
 * строгий разбор блока zone / id-валидация, что в A2 — переиспользовать, не
 * дублировать").
 */
export function loadTaskFileZone(repoRoot: string, task: string): TaskFileZoneLoad {
  if (!isValidTaskId(task)) {
    return { ok: false, reason: `task id "${task}" содержит недопустимые символы (path traversal)` };
  }
  const tasksDir = path.join(repoRoot, ".workflow", "tasks");
  const file = path.join(tasksDir, `${task}.md`);
  const rel = path.relative(tasksDir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `task-file для "${task}" резолвится вне .workflow/tasks/ (path traversal)` };
  }
  const relLabel = `.workflow/tasks/${task}.md`;
  if (!existsSync(file)) {
    return { ok: false, reason: `${relLabel} не найден` };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    return { ok: false, reason: `${relLabel} не читается (${(e as Error).message})` };
  }
  const fm = frontmatter(text);
  if (!fm) {
    return { ok: false, reason: `${relLabel}: frontmatter не найден (нет блока --- ... ---)` };
  }
  const zoneKeyMatch = fm.match(/^zone:[ \t]*(.*)$/m);
  if (!zoneKeyMatch) {
    return { ok: false, reason: `${relLabel}: frontmatter не содержит ключ \`zone\`` };
  }
  if (zoneKeyMatch[1].trim() !== "") {
    return { ok: false, reason: `${relLabel}: \`zone\` не блок allow/deny (скалярное значение)` };
  }
  const blockLists = extractZoneBlockLists(fm);
  if (!blockLists.ok) {
    return { ok: false, reason: `${relLabel}: ${blockLists.reason}` };
  }
  if (blockLists.allow === null || blockLists.allow.length === 0) {
    return { ok: false, reason: `${relLabel}: \`zone.allow\` отсутствует или пуст` };
  }
  return { ok: true, allow: blockLists.allow, deny: blockLists.deny ?? [] };
}

/**
 * Condition (b): a task-file `allow` glob EXPLICITLY rooted at
 * `<protectedRoot>/` (literal prefix — a `**`/`*` glob never qualifies since
 * it cannot start with that literal prefix) matches `normalizedPath`, AND no
 * task-file `deny` glob matches it.
 */
function hasExplicitProtectedAllow(
  normalizedPath: string,
  protectedRoot: string,
  allow: readonly string[],
  deny: readonly string[]
): boolean {
  const prefix = `${protectedRoot.replace(/\/+$/, "")}/`;
  const explicitGlobs = allow.filter((g) => g.startsWith(prefix));
  if (explicitGlobs.length === 0) return false;
  if (!pathMatches(normalizedPath, explicitGlobs)) return false;
  if (deny.length > 0 && pathMatches(normalizedPath, deny)) return false;
  return true;
}

/** Condition (c): covered by the active zone's own `allow`, not its `deny`. */
function coveredByActiveZone(normalizedPath: string, zone: ZoneOptions): boolean {
  const deny = zone.deny ?? [];
  if (deny.length > 0 && pathMatches(normalizedPath, deny)) return false;
  return pathMatches(normalizedPath, zone.allow ?? []);
}

export interface TaskScopedExceptionInput {
  /** Raw staged path as reported by `git diff --cached --name-only`. */
  filePath: string;
  actor: "operator" | "worker" | undefined;
  policy: ResolvedPolicy;
  repoRoot?: string;
  /** `.workflow/active-zone.json`'s own `allow`/`deny` (T8 H2). */
  workerZone?: ZoneOptions;
  /** `.workflow/active-zone.json`'s `task` field (bare id, no `.md`/path). */
  workerZoneTask?: string;
}

export type TaskScopedExceptionOutcome =
  /** Not a `policy.operator_zone.protected` deny (or `.git`) — caller keeps its pre-existing behaviour untouched. */
  | { kind: "not-applicable" }
  /** All of a/b/c hold — caller treats the original deny as waived. */
  | { kind: "exempt" }
  /** At least one condition failed — caller denies with THIS status/reason (names the missing condition). */
  | { kind: "denied"; status: string; reason: string };

/**
 * Evaluate the A2/U13 task-scoped exception for ONE staged path that the
 * plain `classifyPath(actor: "operator", ...)` check already denied. Pure
 * (only `existsSync`/`readFileSync` I/O on the task-file, mirroring
 * `active-zone.ts`'s own fs-wrapper convention) — `commit.ts` calls this
 * INSTEAD of immediately failing on a `deny` verdict, and only fails for
 * real when this returns `"denied"` (or the pre-existing behaviour on
 * `"not-applicable"`).
 */
export function evaluateTaskScopedProtectedException(input: TaskScopedExceptionInput): TaskScopedExceptionOutcome {
  const { policy } = input;
  // Contract "operator_zone.protected в L1" — this exception exists ONLY for
  // the operator-actor protected-floor surface, never the worker allow-lane.
  if (input.actor !== "operator" || !policy.operator_zone.enabled) {
    return { kind: "not-applicable" };
  }

  const normalized = normalizePath(input.filePath, input.repoRoot);
  if (normalized === null) return { kind: "not-applicable" };

  // `.git` / DEFAULT_PROTECTED floor — never eligible (contract "NOT .git"),
  // regardless of whether it ALSO happens to be listed in operator_zone.protected.
  if (pathMatches(normalized, expandBareEntries(DEFAULT_PROTECTED))) {
    return { kind: "not-applicable" };
  }

  // Security review (A2/U13 follow-up): an `operator_zone.protected` entry
  // that ALREADY carries a glob metacharacter (`*`/`?`, e.g. `logs/*.secret`)
  // has no clean "root" a task-file glob could be required to be "explicitly
  // rooted at" (condition b) — such entries are skipped here entirely, so a
  // path matched ONLY by one of them can never reach the exemption path
  // below (falls through to `not-applicable` -> caller's original deny).
  const protectedRoot = policy.operator_zone.protected
    .filter((entry) => !/[*?]/.test(entry))
    .find((entry) => pathMatches(normalized, expandBareEntries([entry])));
  if (protectedRoot === undefined) {
    // Deny wasn't actually caused by a BARE operator_zone.protected entry
    // (e.g. "outside repoRoot", or matched only a glob-metacharacter entry
    // per the security-review note above) -> nothing this module can waive.
    return { kind: "not-applicable" };
  }

  const base = `zone-guard: запись под ${protectedRoot} запрещена (operator_zone protected)`;

  // a) валидная активная зона.
  if (!input.workerZone || !input.workerZoneTask || !input.repoRoot) {
    return {
      kind: "denied",
      status: "zone-violation",
      reason: `${base} — нет активной worker-зоны для task-scoped исключения (условие a).`,
    };
  }

  // b) task-file zone.allow — явный protected-корень, без zone.deny.
  const taskZone = loadTaskFileZone(input.repoRoot, input.workerZoneTask);
  if (!taskZone.ok) {
    return {
      kind: "denied",
      status: "zone-invalid",
      reason: `task-scoped-исключение: ${taskZone.reason}.`,
    };
  }
  if (!hasExplicitProtectedAllow(normalized, protectedRoot, taskZone.allow, taskZone.deny)) {
    return {
      kind: "denied",
      status: "zone-violation",
      reason:
        `${base} — task-file .workflow/tasks/${input.workerZoneTask}.md не даёт явного allow под ` +
        `${protectedRoot}/ для этого пути, или путь покрыт его zone.deny (условие b).`,
    };
  }

  // c) активная зона (active-zone.json) сама покрывает путь.
  if (!coveredByActiveZone(normalized, input.workerZone)) {
    return {
      kind: "denied",
      status: "zone-violation",
      reason: `${base} — путь вне allow активной зоны (.workflow/active-zone.json) или покрыт её deny (условие c).`,
    };
  }

  return { kind: "exempt" };
}
