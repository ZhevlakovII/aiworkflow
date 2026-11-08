/**
 * py-text (T7-4) — tiny shared helper replicating a Python `str` semantics that
 * has no direct JS equivalent, needed by several ported design-driver modules
 * (`claude-worker.ts`, `design-stage.ts`).
 *
 * `str.split(sep, maxsplit)` performs AT MOST `maxsplit` splits and folds any
 * remaining separator occurrences into the LAST returned element. JS's
 * `Array.prototype` has no `String.split(sep, limit)` equivalent —
 * `"a-b-c-d".split("-", 2)` in JS just TRUNCATES the fully-split array to 2
 * elements (`["a","b"]`, discarding `"c-d"`), whereas Python's
 * `"a-b-c-d".split("-", 2)` yields `["a", "b", "c-d"]` (remainder preserved).
 * Both `tools/claude_worker.py`'s `role_prompt` (`text.split("---", 2)`) and
 * `tools/design_stage.py`'s `parse_task` (`text.split("---", 2)[1]`) rely on
 * the remainder-preserving behaviour — porting via `String.split` would
 * silently truncate any agent-role-file / task-file body that itself contains
 * a third `"---"` (e.g. a markdown horizontal rule).
 */
export function splitMaxsplit(text: string, sep: string, maxSplits: number): string[] {
  const parts: string[] = [];
  let rest = text;
  for (let i = 0; i < maxSplits; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  parts.push(rest);
  return parts;
}
