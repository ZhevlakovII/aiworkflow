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
const ERROR_EVENTS = ["model_error", "request_error", "tool_error", "tool_timeout", "tool_aborted", "tool_call_loop_detected", "request_aborted", "request_canceled", "model_context_window_exceeded", "model_not_loaded"];
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

/** Аккумулирует usage по ФАКТИЧЕСКОЙ схеме OMP (18.x), а не по фаззи-регекспам:
 *   usage:{ input, output, cacheRead, cacheWrite, totalTokens, cost:{input,output,cacheRead,cacheWrite,total} }
 *   duration (мс) лежит РЯДОМ с usage на объекте хода (message/assistant-turn).
 * Ключи голые (`input`/`output`), поэтому читаем только внутри объекта `usage` — иначе tool-call `input`
 * (аргументы тула) ложно засчитался бы как токены. Собираем со ВСЕХ usage-объектов в payload (agent_end
 * несёт массив messages[].usage). */
function digUsage(v: unknown, out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (!v || typeof v !== "object" || depth > 6) return out;
  const o = v as Record<string, unknown>;
  const u = o.usage;
  if (u && typeof u === "object") {
    const uu = u as Record<string, unknown>;
    const add = (dst: string, val: unknown) => { if (typeof val === "number") out[dst] = (out[dst] || 0) + val; };
    add("inputTok", uu.input); add("outputTok", uu.output);
    add("cacheRead", uu.cacheRead); add("cacheWrite", uu.cacheWrite);
    if (typeof uu.totalTokens === "number") out.totalTok = Math.max(out.totalTok || 0, uu.totalTokens);
    const c = uu.cost;                                       // cost стал вложенным объектом (18.x), не числом
    if (typeof c === "number") out.cost = (out.cost || 0) + c;
    else if (c && typeof c === "object" && typeof (c as Record<string, unknown>).total === "number") out.cost = (out.cost || 0) + (c as Record<string, number>).total;
    if (typeof o.duration === "number") out.durationMs = o.duration; // длительность ИМЕННО хода с usage
  }
  for (const val of Object.values(o)) if (val && typeof val === "object") digUsage(val, out, depth + 1);
  return out;
}

/** Ловит провал УРОВНЯ СООБЩЕНИЯ: LiteLLM/провайдер оборачивает ошибку в HTTP 200 (транспорт ОК) +
 *  ставит stopReason:"error" с errorMessage на самом сообщении/model_usage. Такие ошибки невидимы и по
 *  HTTP-статусу (200), и по usage-числам (нули) → отдельный рекурсивный детект.
 *  Кейсы (2026-09-04, deepseek-v4-flash через LiteLLM): 400 UnsupportedParamsError reasoning_effort
 *  (auto-thinking саб-вызов) и "socket connection closed unexpectedly" на длинном стриме. */
function digStopError(v: unknown, depth = 0): { errored: boolean; msg: string } {
  if (!v || typeof v !== "object" || depth > 6) return { errored: false, msg: "" };
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  let errored = false;
  if (typeof o.stopReason === "string" && o.stopReason.toLowerCase() === "error") {
    errored = true;
    if (typeof o.errorMessage === "string") parts.push(o.errorMessage);
    if (typeof o.errorId === "number") parts.push(`errorId=${o.errorId}`);
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object") {
      const r = digStopError(val, depth + 1);
      if (r.errored) { errored = true; if (r.msg) parts.push(r.msg); }
    }
  }
  return { errored, msg: parts.filter(Boolean).join(" ") };
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
    seenShapes[event] = process.env.OMP_TELEMETRY_DEEP === "1" ? JSON.parse(JSON.stringify(payload, (_k, v) => typeof v === "bigint" ? Number(v) : v)) : summary(payload);
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
        const p = payload as Record<string, unknown> | undefined;
        rec.tool = p?.toolName ?? p?.tool_name;                                 // если tool_error — сохраним имя
        const text = [p?.errorMessage, p?.errorText, p?.error].filter((x) => typeof x === "string").join(" ") || digError(payload) || JSON.stringify(summary(payload));
        rec.errClass = classifyError(text, undefined, event.startsWith("tool") ? "tool" : "request"); rec.errMsg = errExcerpt(text);
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
        // message-layer провал (stopReason:error в 200-ответе) ПЕРЕД usage — иначе нулевой usage → return и ошибка теряется.
        const se = digStopError(payload);
        if (se.errored) {
          rec.kind = "omp-error";
          const text = se.msg || digError(payload) || JSON.stringify(summary(payload));
          rec.errClass = classifyError(text, undefined, "request"); rec.errMsg = errExcerpt(text);
          const u = digUsage(payload); if (Object.keys(u).length) rec.usage = u; // usage при наличии — для cost падений
        } else {
          const u = digUsage(payload); if (Object.keys(u).length) rec.usage = u; else return; // без чисел — не шумим
        }
      } else if (kind === "omp-tool") {
        const p = payload as Record<string, unknown> | undefined;
        rec.tool = p?.toolName ?? p?.tool_name ?? p?.name ?? p?.tool;          // OMP 18.x: camelCase toolName
        rec.toolCallId = p?.toolCallId ?? p?.tool_call_id ?? p?.id;
        if (typeof p?.duration === "number") rec.durationMs = p.duration;      // duration тула — верхний уровень
        // OMP 18.x tool-фейл: isError/hasError флаг + текст в errorMessage/errorText (не errorId — то число).
        const failed = p?.isError === true || p?.hasError === true;
        const errText = [p?.errorMessage, p?.errorText, p?.error].filter((x) => typeof x === "string").join(" ") || digError(payload);
        if (failed || (errText && /error|fail|denied|refused/i.test(errText))) {
          rec.isError = true; rec.errClass = classifyError(errText, undefined, "tool"); rec.errMsg = errExcerpt(errText);
        }
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
