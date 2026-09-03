// omp-telemetry — телеметрия САМОГО OMP как точки взаимодействия (запросы к модели, lead, тул-вызовы,
//   делегация, ошибки, затраты). Отдельно от нашей tool-телеметрии (_lib/telemetry.ts инструментирует
//   ТОЛЬКО наши customTools): этот хук ловит ЛЮБОЙ omp-прогон — в т.ч. нативные task-агенты и lead-ходы,
//   которые наши тулы не видят.
//
// Пишет NDJSON в <cwd>/.workflow/telemetry-omp.ndjson + ~/.omp/agent/telemetry-omp.ndjson.
//   Записи (kind): "omp-error" (ошибки запроса/тула/модели, с errClass), "omp-usage" (usage/cost на
//   ответ модели), "omp-tool" (тул-исполнение: имя/длительность/исход), "omp-agent" (lifecycle lead/
//   субагентов/делегация), "omp-event" (прочее сырьё).
// Первая встреченная форма КАЖДОГО события → .workflow/logs/omp-events-schema.json (self-discovery:
//   точная сигнатура pi.on-колбэков в OMP не документирована → сохраняем форму для итерации).
// ARMED по умолчанию; выкл. env OMP_TELEMETRY_OFF=1. НИКОГДА не бросает в поток (всё в try/catch).
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyError, errExcerpt } from "../tools/_lib/errclass";

// Кандидат-события (из строк omp-бинаря). Неподдержанные pi.on'ом — guarded, просто не подпишутся.
const ERROR_EVENTS = ["model_error", "tool_error", "tool_timeout", "tool_call_loop_detected", "request_aborted", "request_canceled", "model_context_window_exceeded", "model_not_loaded"];
const USAGE_EVENTS = ["agent_context_usage", "message_end", "response_item"];
// provider = фактический HTTP-запрос к модели (deepseek/qwen/…): статус, requestId — ядро для ошибок запроса.
const PROVIDER_EVENTS = ["before_provider_request", "after_provider_response"];
const TOOL_EVENTS  = ["tool_execution_start", "tool_execution_end", "tool_call", "tool_result", "tool_blocked", "tool_skipped", "tool_approval_requested", "tool_approval_resolved"];
const AGENT_EVENTS = ["agent_start", "agent_end", "subagent_lifecycle", "subagent_event", "subagent_progress", "model_change", "session_start", "session_exit"];

/** Безопасная компактная выжимка payload'а: примитивы как есть, объекты — их ключи+примитив-поля (1 уровень). */
function summary(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== "object") return typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  if (depth >= 2) return Array.isArray(v) ? `[${v.length}]` : "{…}";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => summary(x, depth + 1));
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).slice(0, 40)) {
    try { const val = (v as Record<string, unknown>)[k]; if (typeof val !== "function") o[k] = summary(val, depth + 1); }
    catch { /* getter кинул — пропускаем */ }
  }
  return o;
}

/** Глубоко ищет числовые usage/cost поля в payload (имена варьируются между фреймами). */
function digUsage(v: unknown, out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (!v || typeof v !== "object" || depth > 4) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (typeof val === "number") {
      if (/input.*token|prompt.*token/.test(key)) out.inputTok = (out.inputTok || 0) + val;
      else if (/output.*token|completion.*token/.test(key)) out.outputTok = (out.outputTok || 0) + val;
      else if (/total.*token/.test(key)) out.totalTok = val;
      else if (/cache.*read/.test(key)) out.cacheRead = (out.cacheRead || 0) + val;
      else if (/cost/.test(key)) out.cost = (out.cost || 0) + val;
      else if (/duration|elapsed|latency/.test(key)) out.durationMs = val;
    } else if (val && typeof val === "object") digUsage(val, out, depth + 1);
  }
  return out;
}

/** Ищет текст ошибки в payload (для классификации). */
function digError(v: unknown, depth = 0): string {
  if (v == null || depth > 4) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return "";
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (/error|message|detail|reason|description|status|code/i.test(k)) {
      if (typeof val === "string" || typeof val === "number") parts.push(`${k}=${val}`);
      else if (val && typeof val === "object") parts.push(digError(val, depth + 1));
    }
  }
  return parts.filter(Boolean).join(" ");
}

export default function hook(pi: HookAPI): void {
  if (process.env.OMP_TELEMETRY_OFF === "1") return;
  const cwd = pi.cwd;
  const logsDir = path.resolve(cwd, ".workflow/logs");
  const schemaPath = path.join(logsDir, "omp-events-schema.json");
  const seenShapes: Record<string, unknown> = (() => { try { return JSON.parse(fs.readFileSync(schemaPath, "utf8")); } catch { return {}; } })();

  const append = (obj: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
    for (const t of [path.resolve(cwd, ".workflow/telemetry-omp.ndjson"), path.join(os.homedir(), ".omp", "agent", "telemetry-omp.ndjson")]) {
      try { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.appendFileSync(t, line, "utf8"); } catch { /* best-effort */ }
    }
  };
  const recordShape = (event: string, payload: unknown): void => {
    if (event in seenShapes) return;
    seenShapes[event] = summary(payload);
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.writeFileSync(schemaPath, JSON.stringify(seenShapes, null, 2), "utf8"); } catch { /* best-effort */ }
  };

  const classOf = (event: string): "omp-error" | "omp-usage" | "omp-tool" | "omp-agent" | "omp-provider" | "omp-event" =>
    ERROR_EVENTS.includes(event) ? "omp-error" : PROVIDER_EVENTS.includes(event) ? "omp-provider" :
    USAGE_EVENTS.includes(event) ? "omp-usage" : TOOL_EVENTS.includes(event) ? "omp-tool" :
    AGENT_EVENTS.includes(event) ? "omp-agent" : "omp-event";

  const onEvent = (event: string, args: unknown[]): void => {
    try {
      const payload = args[0];                 // args = [eventObj, uiObj]; eventObj несёт .type + поля
      recordShape(event, args.length > 1 ? args : payload);
      const kind = classOf(event);
      const rec: Record<string, unknown> = { kind, event };
      if (kind === "omp-error") {
        const text = digError(payload) || JSON.stringify(summary(payload));
        rec.errClass = classifyError(text); rec.errMsg = errExcerpt(text);
      } else if (kind === "omp-provider") {
        // Фактический запрос к модели. status>=400 = ошибка запроса (deepseek 429/400/5xx и т.п.).
        const p = payload as Record<string, unknown> | undefined;
        const status = typeof p?.status === "number" ? p.status : undefined;
        rec.status = status; rec.requestId = p?.requestId ?? p?.request_id; rec.model = p?.model;
        const u = digUsage(payload); if (Object.keys(u).length) rec.usage = u;
        if (status != null && status >= 400) {
          rec.kind = "omp-error"; rec.errClass = classifyError(`status ${status} ${digError(payload)}`); rec.errMsg = errExcerpt(`HTTP ${status} ${digError(payload)}`);
        } else if (event === "before_provider_request") { return; }  // запрос без исхода — не шумим (ответ запишем)
      } else if (kind === "omp-usage") {
        const u = digUsage(payload); if (Object.keys(u).length) rec.usage = u; else return; // без чисел — не шумим
      } else if (kind === "omp-tool") {
        const p = payload as Record<string, unknown> | undefined;
        rec.tool = p?.tool_name ?? p?.name ?? p?.tool; rec.toolCallId = p?.tool_call_id ?? p?.id;
        const u = digUsage(payload); if (u.durationMs) rec.durationMs = u.durationMs;
        const err = digError(payload); if (err && /error|fail/i.test(err)) { rec.errClass = classifyError(err); rec.errMsg = errExcerpt(err); }
      } else if (kind === "omp-agent") {
        const p = payload as Record<string, unknown> | undefined;
        rec.agentType = p?.agent_type ?? p?.type ?? p?.agent; rec.model = p?.model;
        const u = digUsage(payload); if (Object.keys(u).length) rec.usage = u;
      } else {
        rec.summary = summary(payload);
      }
      append(rec);
    } catch { /* глотаем — телеметрия не влияет на поток */ }
  };

  // Guarded-подписка: неподдержанное pi.on'ом событие просто бросит/вернёт — ловим, продолжаем.
  const all = [...ERROR_EVENTS, ...PROVIDER_EVENTS, ...USAGE_EVENTS, ...TOOL_EVENTS, ...AGENT_EVENTS];
  const subscribed: string[] = [];
  for (const ev of all) {
    try { (pi.on as (e: string, cb: (...a: unknown[]) => void) => void)(ev, (...a: unknown[]) => onEvent(ev, a)); subscribed.push(ev); }
    catch { /* событие не подписываемо в этой версии — ок */ }
  }
  try { append({ kind: "omp-event", event: "telemetry_armed", summary: { subscribed: subscribed.length, events: subscribed } }); } catch { /* ignore */ }

  pi.registerCommand?.("omp-telemetry", {
    description: "omp-telemetry status (subscribed events)",
    handler: async () => `omp-telemetry ARMED. subscribed=${subscribed.length}: ${subscribed.join(", ")}`,
  });
}
