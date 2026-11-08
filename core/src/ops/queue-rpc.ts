/**
 * queue-rpc core (T7-5, contract L-1/L-4) — pure helpers extracted from
 * `tools/queue_rpc.py`'s session-keeper (task-id extraction, drained-check,
 * error-event classification). The spawn/stdio/timer glue that holds the
 * persistent `omp --mode=rpc` session open lives in `./queue-rpc-cli.ts`
 * (OMP-glue, ported "as-is" per contract L-4 — NOT the queue's actual
 * dispatch/verdict/routing logic, which lives INSIDE OMP's
 * `queue-runner.ts` hook).
 */

export const KICK =
  "Autonomous queue mode armed. Reply exactly QUEUE-READY, then process each injected " +
  "task prompt as it arrives. Do nothing else on your own.";

export type QueueState = Record<string, string>;

/** A task-file's `id:` frontmatter field, falling back to the filename stem (no extension) — same as Python's per-file `task_ids()` logic. */
export function extractTaskId(fileText: string, stem: string): string {
  const m = /^\s*id:\s*(.+?)\s*$/m.exec(fileText);
  return m ? m[1].trim() : stem;
}

/** Queue drained: every id in `ids` is terminal (`done`/`blocked`) in `state`. Empty `ids` -> false (never "drained" with zero tasks) — same as Python's `all_terminal()`. */
export function allTerminal(ids: ReadonlySet<string>, state: QueueState): boolean {
  if (ids.size === 0) return false;
  for (const id of ids) {
    const s = state[id];
    if (s !== "done" && s !== "blocked") return false;
  }
  return true;
}

const ERR_RE = /"type"\s*:\s*"error"|"error"\s*:\s*\{|"level"\s*:\s*"error"|"isError"\s*:\s*true/i;

/** Same classification as Python's `is_error_event()`: prefer the parsed event shape, fall back to a raw-line regex when the line wasn't valid JSON. */
export function isErrorEvent(line: string, ev: Record<string, unknown> | null): boolean {
  if (ev !== null) {
    if (ev.type === "error" || ev.isError === true || ev.level === "error") return true;
    const err = ev.error;
    if ((typeof err === "object" && err !== null) || (typeof err === "string" && err.length > 0)) return true;
    const sub = ev.subtype ?? ev.kind;
    if (typeof sub === "string" && sub.toLowerCase().includes("error")) return true;
    return false;
  }
  return ERR_RE.test(line);
}
