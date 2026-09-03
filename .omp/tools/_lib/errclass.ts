// errclass — классификация ошибок воркера/запроса для телеметрии (task-4: трекать ошибки + причины).
// Проблема, которую закрывает: раньше worker-error писал в телеметрию только "backend rc=N" —
//   ПРИЧИНА (auth/rate-limit/context/network/…) терялась (жила лишь в возвращённом caller-логе).
//   Прогон deepseek: "работает, но ловятся ошибки запроса, непонятно почему" → нужна классификация.
// Две функции:
//   classifyError(text, code) — грубый тип фейла (одна метка) по stderr/stdout + exit-code.
//   scanRequestErrors(text)   — считает request-error сигнатуры В ПОТОКЕ даже при rc=0
//                               (omp/openai-completions ретраит внутри → run "committed", но ошибки были).

export type ErrClass =
  | "auth" | "rate-limit" | "context-length" | "model-not-found" | "bad-request"
  | "server-error" | "network" | "timeout" | "cli-missing" | "killed"
  | "git" | "config" | "unknown";

interface Rule { cls: ErrClass; re: RegExp; }

// Порядок = приоритет (специфичное раньше generic). Матч по объединённому stderr+stdout.
const RULES: Rule[] = [
  { cls: "auth",           re: /\b(401|403)\b|unauthor|invalid api key|authentication|forbidden|invalid[_ -]?token|api[_ -]?key/i },
  { cls: "rate-limit",     re: /\b429\b|rate[_ -]?limit|too many requests|quota|insufficient[_ -]?quota/i },
  { cls: "context-length", re: /context[_ -]?(length|window)|maximum context|too many tokens|context_length_exceeded|reduce the length/i },
  { cls: "model-not-found",re: /\b404\b|model[_ -]?not[_ -]?found|no such model|unknown model|does not exist|model_not_found/i },
  { cls: "server-error",   re: /\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable|overloaded|server_error|upstream/i },
  { cls: "timeout",        re: /timed?[_ -]?out|timeout|deadline exceeded|ETIMEDOUT|request timeout/i },
  { cls: "network",        re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|connection (refused|reset|closed)|network error|fetch failed|getaddrinfo/i },
  { cls: "bad-request",    re: /\b400\b|bad request|invalid request|malformed|unprocessable|422/i },
];

/** Одна метка типа фейла по тексту stderr(+stdout) и exit-code. */
export function classifyError(text: string, code?: number): ErrClass {
  const t = text || "";
  if (code === 127 || /command not found|not recognized|no such file or directory|ENOENT/i.test(t)) return "cli-missing";
  if (typeof code === "number" && code < 0) return "killed";           // сигнал (node: -signal)
  if (/SIGKILL|SIGTERM|out of memory|OOM|killed/i.test(t)) return "killed";
  if (/^fatal:|not a git repository|nothing to commit|git\b.*fail/im.test(t)) return "git";
  for (const r of RULES) if (r.re.test(t)) return r.cls;
  if (code === 137) return "killed";
  return "unknown";
}

/** Короткая выжимка причины (первая осмысленная строка, обрезано). Для errMsg в телеметрии/логе. */
export function errExcerpt(text: string, max = 200): string {
  const lines = (text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // предпочитаем строку с сигнатурой ошибки, иначе последнюю непустую (стек-тейл).
  const hit = lines.find((l) => RULES.some((r) => r.re.test(l)) || /error|fail|exception/i.test(l));
  const pick = hit || lines[lines.length - 1] || "";
  return pick.length > max ? pick.slice(0, max - 1) + "…" : pick;
}

export interface ReqErrorScan { count: number; classes: ErrClass[]; sample: string; }

/** Считает request-error сигнатуры в потоке воркера (stdout NDJSON error-фреймы + stderr).
 *  Ловит «тихие» ошибки запроса при rc=0 (провайдер ретраил внутри). count=0 → чисто. */
export function scanRequestErrors(text: string): ReqErrorScan {
  const classes = new Set<ErrClass>();
  let count = 0;
  let sample = "";
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // NDJSON error-фрейм omp/провайдера ИЛИ явная http/keyword-сигнатура в строке.
    const isErrFrame = /"type"\s*:\s*"error"|"error"\s*:\s*\{|"status"\s*:\s*(4\d\d|5\d\d)/i.test(line);
    const matched = RULES.find((r) => r.re.test(line));
    if (isErrFrame || matched) {
      count++;
      classes.add(matched ? matched.cls : classifyError(line));
      if (!sample) sample = errExcerpt(line);
    }
  }
  return { count, classes: [...classes], sample };
}
