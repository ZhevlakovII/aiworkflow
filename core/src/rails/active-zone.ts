/**
 * Commit-time worker-zone source (T8 H2/H3, contract
 * `.workflow/tasks/t8-status-quo-holes.md`).
 *
 * Unlike the hook-side `loadActiveZoneFile` (`wiring/policy-source.ts`),
 * which collapses "missing" and "malformed" into one `undefined` sentinel
 * (both mean deny-all for a worker there), the L1 rail must tell them apart:
 *  - file absent      -> `{ kind: "none" }`  (pre-T8 behaviour, no zone-check)
 *  - valid file       -> `{ kind: "zone" }`  (staged paths checked against it)
 *  - present but bad  -> `{ kind: "invalid" }` (fail-closed: commit refused)
 * Valid = UTF-8 JSON object (leading BOM tolerated), `task`: non-empty
 * string, `allow`: string[], optional `deny`: string[], optional `by`:
 * string (`"judge"` | other | absent — Contract B mutual exclusion).
 *
 * Self-protection floor (same as the hook loader): `ACTIVE_ZONE_PATH` is
 * always merged into `deny`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ACTIVE_ZONE_REL = ".workflow/active-zone.json";

export type ActiveZoneLoad =
  | { kind: "none" }
  | {
      kind: "zone";
      task: string;
      zone: { allow: string[]; deny: string[] };
      /** Optional zone author — `"judge"` for judge-owned zones (Contract B). */
      by?: string;
    }
  | { kind: "invalid"; reason: string };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Security review (A2/U13 follow-up) — `task` flows into a filesystem path
 * join (`./task-scoped-protected.ts`'s `.workflow/tasks/<task>.md`); a bare
 * "non-empty string" check let a path-traversal payload (`../x`, `a/b`,
 * `a\\b`, an absolute path, or a literal `..`) through unvalidated. Exported
 * so `./task-scoped-protected.ts` re-validates defensively right before its
 * own `path.join` too (defence in depth — never trust a single call site).
 * Deliberately conservative: no `/`, no `\`, no `..` substring at all — a
 * plain `[A-Za-z0-9._-]` id, first char alnum.
 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id) && !id.includes("..");
}

/** Pure validation of already-read file text (exported for tests). */
export function parseActiveZone(text: string): ActiveZoneLoad {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { kind: "invalid", reason: `не JSON (${(e as Error).message})` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", reason: "ожидался JSON-объект {task, allow[, deny]}" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.task !== "string" || obj.task.trim() === "") {
    return { kind: "invalid", reason: "`task` отсутствует или не непустая строка" };
  }
  if (!isValidTaskId(obj.task)) {
    return {
      kind: "invalid",
      reason: "`task` содержит недопустимые символы (path traversal) — ожидался [A-Za-z0-9._-], без '..'",
    };
  }
  if (!isStringArray(obj.allow)) {
    return { kind: "invalid", reason: "`allow` отсутствует или не string[]" };
  }
  if (obj.deny !== undefined && !isStringArray(obj.deny)) {
    return { kind: "invalid", reason: "`deny` не string[]" };
  }
  // Contract B: optional `by` — non-string values ignored (do not break L1 load).
  const by = typeof obj.by === "string" ? obj.by : undefined;
  const deny = [...((obj.deny as string[] | undefined) ?? []), ACTIVE_ZONE_REL];
  return { kind: "zone", task: obj.task, zone: { allow: obj.allow, deny }, by };
}

/** fs wrapper: `<repoRoot>/.workflow/active-zone.json`. Unreadable existing file -> `invalid` (fail-closed). */
export function loadActiveZoneForCommit(repoRoot: string): ActiveZoneLoad {
  const file = path.join(repoRoot, ACTIVE_ZONE_REL);
  if (!existsSync(file)) return { kind: "none" };
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (e) {
    return { kind: "invalid", reason: `не читается (${(e as Error).message})` };
  }
  return parseActiveZone(text);
}
