/**
 * telemetry core (T7-5, contract L-1/L-2) — pure record-building logic, TS
 * port of the record shape written by `.claude/hooks/telemetry.py`
 * (best-effort NDJSON, `kind:tool` rows only — the `kind:run`/`kind:guard`
 * rows are written by the rails/queue drivers themselves, not this hook).
 *
 * Kept separate from `./telemetry-hook.ts` (the actual PostToolUse shell)
 * so the byte-format of a written line is unit-testable without touching
 * real fs/stdin (contract L-2: the hook itself must stay fast/silent).
 */

export const MAX_BYTES = 20 * 1024 * 1024;

export interface TelemetryHookInput {
  cwd?: string;
  tool_name?: string;
  tool_response?: unknown;
}

export interface TelemetryRecord {
  ts: string;
  kind: "tool";
  tool: string;
  ok: boolean;
}

/**
 * Mirrors Python's `time.strftime("%Y-%m-%dT%H:%M:%S")` — LOCAL time,
 * second precision, no timezone suffix, no milliseconds.
 */
export function formatTs(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * `ok` mirrors Python: a `tool_response` dict with a truthy `is_error` or
 * `error` key -> false, anything else (non-dict response, or a dict without
 * those keys set) -> true.
 */
function isOk(resp: unknown): boolean {
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const r = resp as Record<string, unknown>;
    if (r.is_error || r.error) return false;
  }
  return true;
}

export function buildRecord(data: TelemetryHookInput, now: Date): TelemetryRecord {
  return {
    ts: formatTs(now),
    kind: "tool",
    tool: data.tool_name ?? "",
    ok: isOk(data.tool_response),
  };
}
