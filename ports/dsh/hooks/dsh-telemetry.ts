// dsh-telemetry — harness-level NDJSON (Cordis events). Off: DSH_TELEMETRY_OFF=1.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CordisContext } from "../tools/_lib/cordis.ts";
import { classifyError, errExcerpt } from "../tools/_lib/errclass.ts";

const ERROR_EVENTS = [
  "model_error",
  "request_error",
  "tool_error",
  "tool_timeout",
  "tool_aborted",
  "request_aborted",
  "model_context_window_exceeded",
];
const TOOL_EVENTS = ["tool_execution_start", "tool_execution_end", "tool_call", "tool_result", "tool_blocked"];
const SESSION_EVENTS = ["session_start", "session_exit", "agent_start", "agent_end"];

function summary(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object") return typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  if (depth >= 2) return Array.isArray(v) ? `[${v.length}]` : "{…}";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => summary(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).slice(0, 40)) {
    try {
      const val = (v as Record<string, unknown>)[k];
      if (typeof val !== "function") o[k] = summary(val, depth + 1);
    } catch {
      /* getter */
    }
  }
  return o;
}

function digError(v: unknown, depth = 0): string {
  if (v == null || depth > 4) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return "";
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (/error|message|detail|reason/i.test(k)) {
      if (typeof val === "string" || typeof val === "number") parts.push(`${k}=${val}`);
      else if (val && typeof val === "object") parts.push(digError(val, depth + 1));
    }
  }
  return parts.filter(Boolean).join(" ");
}

export function registerDshTelemetry(ctx: CordisContext): void {
  if (process.env.DSH_TELEMETRY_OFF === "1") return;
  const cwd = ctx.cwd;
  const logsDir = path.resolve(cwd, ".workflow/logs");
  const schemaPath = path.join(logsDir, "dsh-events-schema.json");
  const seenShapes: Record<string, unknown> = (() => {
    try {
      return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    } catch {
      return {};
    }
  })();

  const append = (obj: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
    for (const t of [
      path.resolve(cwd, ".workflow/telemetry-dsh.ndjson"),
      path.join(os.homedir(), ".dsh", "agent", "telemetry-dsh.ndjson"),
    ]) {
      try {
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.appendFileSync(t, line, "utf8");
      } catch {
        /* best-effort */
      }
    }
  };

  const recordShape = (event: string, payload: unknown): void => {
    if (event in seenShapes) return;
    seenShapes[event] = summary(payload);
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(schemaPath, JSON.stringify(seenShapes, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
  };

  const classOf = (event: string): "dsh-error" | "dsh-tool" | "dsh-session" | "dsh-event" =>
    ERROR_EVENTS.includes(event) ? "dsh-error" : TOOL_EVENTS.includes(event) ? "dsh-tool" :
    SESSION_EVENTS.includes(event) ? "dsh-session" : "dsh-event";

  const onEvent = (event: string, payload: unknown): void => {
    try {
      recordShape(event, payload);
      const kind = classOf(event);
      const rec: Record<string, unknown> = { kind, event };
      const p = payload as Record<string, unknown> | undefined;
      if (kind === "dsh-error") {
        const text =
          [p?.errorMessage, p?.errorText, p?.error].filter((x) => typeof x === "string").join(" ") ||
          digError(payload) ||
          JSON.stringify(summary(payload));
        rec.errClass = classifyError(text, undefined, event.startsWith("tool") ? "tool" : "request");
        rec.errMsg = errExcerpt(text);
      } else if (kind === "dsh-tool") {
        rec.tool = p?.toolName ?? p?.tool_name ?? p?.name;
        if (typeof p?.duration === "number") rec.durationMs = p.duration;
        if (p?.isError === true || p?.hasError === true) {
          const errText =
            [p?.errorMessage, p?.errorText, p?.error].filter((x) => typeof x === "string").join(" ") || digError(payload);
          rec.isError = true;
          rec.errClass = classifyError(errText, undefined, "tool");
          rec.errMsg = errExcerpt(errText);
        }
      } else if (kind === "dsh-session") {
        rec.agentType = p?.agent_type ?? p?.type ?? p?.agent;
        rec.model = p?.model;
      } else {
        rec.summary = summary(payload);
      }
      append(rec);
    } catch {
      /* telemetry must not break harness */
    }
  };

  const all = [...ERROR_EVENTS, ...TOOL_EVENTS, ...SESSION_EVENTS];
  const subscribed: string[] = [];
  for (const ev of all) {
    try {
      ctx.hooks.on(ev, async (raw) => {
        onEvent(ev, raw);
      });
      subscribed.push(ev);
    } catch {
      /* unsupported in this Cordis build */
    }
  }
  try {
    append({ kind: "dsh-event", event: "telemetry_armed", summary: { subscribed: subscribed.length, events: subscribed } });
  } catch {
    /* ignore */
  }
}
