/**
 * A5a — effective quality-gate resolution for the L1 commit rail (`./cli.ts`)
 * while a worker zone is active (contract
 * `.workflow/tasks/a5a-cc-execute-rail-gate.md`).
 *
 * Fact this closes: with an active `.workflow/active-zone.json`, `cli.ts`
 * forced `gateCmd: undefined` unconditionally, so `commit.ts`'s own
 * `gateCmd ?? policy.quality_gate.cmd` fallback only ever saw the policy cmd —
 * the task-file's OWN `test-cmd` (the immutable per-task contract, not a lead
 * choice) was never consulted. A project with no `policy.quality_gate.cmd`
 * (e.g. FinManage) then committed execute-stage work with NO gate at all.
 *
 * Resolution order (contract §Требуется п.1): task-file `test-cmd` -> (absent)
 * `policy.quality_gate.cmd` (left to the caller — this module only reports
 * `"none"`, `cli.ts` applies the policy fallback itself, same as pre-A5a) ->
 * (absent) no gate, unchanged pre-A5a behaviour.
 *
 * Fail-closed, no silent fallback (post-security-review, lead decision):
 * ANY failure to resolve the task-file's own gate contract -> `{ kind:
 * "invalid" }` (`zone-invalid`, no commit) — this INCLUDES the task-file not
 * existing at all (an active zone naming a task-file that isn't there is
 * itself a broken contract, not "no test-cmd declared"; a real active zone
 * always names a real task-file, T7-0). The zone-block parse + task-id
 * validation is reused verbatim from A2 (`./task-scoped-protected.ts`'s
 * exported `loadTaskFileZone`, whose `ok:false` already covers missing file /
 * unreadable / no frontmatter / no `zone` block / `zone.allow` missing/empty /
 * duplicate keys) — this module does not re-implement or drift a second copy
 * of it, and does not special-case any of its failure reasons into a silent
 * pass.
 *
 * `test-cmd` itself is a plain TOP-LEVEL frontmatter scalar, a sibling of the
 * `zone:` block (the convention already used by every real task-file, e.g.
 * `.workflow/tasks/canon-impl-p5.md`, and by the existing `design/gate-setup.ts`
 * / `design/task-zone.ts` readers) — extracted here via those same exported
 * `frontmatter`/`scalar` helpers, not a new parser. Security review finding:
 * `scalar()` unquotes (`"  "` -> `  `) WITHOUT re-trimming afterwards — a
 * present-but-blank `test-cmd: "   "` would otherwise resolve to `{ kind:
 * "cmd", cmd: "   " }`, and an empty shell command exits 0 unconditionally
 * (green with zero tests actually run, misreported as `gate: task`). Fixed
 * here (NOT in the shared `design/task-zone.ts`, out of this task's zone) by
 * re-trimming the unquoted value and treating a present-but-blank result the
 * same as a broken task-file: `{ kind: "invalid" }`, fail-closed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { frontmatter, scalar } from "../design/task-zone.ts";
import { loadTaskFileZone } from "./task-scoped-protected.ts";

export type TaskGateResolution =
  | { kind: "cmd"; cmd: string }
  | { kind: "none" }
  | { kind: "invalid"; reason: string };

/**
 * `repoRoot`/`task` — same shape as `loadActiveZoneForCommit`'s `.task` field
 * (`./active-zone.ts`, already `isValidTaskId`-checked by `parseActiveZone`
 * before this is ever reached; `loadTaskFileZone` re-validates defensively
 * regardless, same defence-in-depth convention as the rest of this surface).
 */
export function resolveTaskGateCmd(repoRoot: string, task: string): TaskGateResolution {
  const zone = loadTaskFileZone(repoRoot, task);
  if (!zone.ok) {
    return { kind: "invalid", reason: zone.reason };
  }

  // `zone.ok` -> the task-file exists, is readable, and its frontmatter/zone
  // block already parsed cleanly above — safe to read it again for the
  // sibling top-level `test-cmd` scalar (small file, no new failure surface
  // `loadTaskFileZone` didn't already clear).
  const file = path.join(repoRoot, ".workflow", "tasks", `${task}.md`);
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    return {
      kind: "invalid",
      reason: `.workflow/tasks/${task}.md: не читается повторно для test-cmd (${(e as Error).message})`,
    };
  }
  const raw = scalar(frontmatter(text), "test-cmd");
  if (raw === undefined) return { kind: "none" };
  const testCmd = raw.trim();
  if (testCmd === "") {
    return {
      kind: "invalid",
      reason: `.workflow/tasks/${task}.md: \`test-cmd\` присутствует, но пуст/только пробелы`,
    };
  }
  return { kind: "cmd", cmd: testCmd };
}
