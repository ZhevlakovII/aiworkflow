// errclass — error classification for telemetry (ported from ports/omp/tools/_lib/errclass.ts).

export type ErrClass =
  | "auth" | "rate-limit" | "context-length" | "model-not-found" | "bad-request"
  | "server-error" | "network" | "timeout" | "cli-missing" | "killed"
  | "git" | "config"
  | "fs-permission" | "fs-not-found" | "fs-exists" | "fs-space" | "fs-invalid" | "tool-error"
  | "unknown";

interface Rule { cls: ErrClass; re: RegExp; }

const RULES: Rule[] = [
  { cls: "auth",           re: /\b(401|403)\b|unauthor|invalid api key|authentication|forbidden|invalid[_ -]?token|api[_ -]?key/i },
  { cls: "rate-limit",     re: /\b429\b|rate[_ -]?limit|too many requests|quota|insufficient[_ -]?quota/i },
  { cls: "context-length", re: /context[_ -]?(length|window)|maximum context|too many tokens|context_length_exceeded|reduce the length/i },
  { cls: "model-not-found",re: /\b404\b|model[_ -]?not[_ -]?found|no such model|unknown model|does not exist|model_not_found/i },
  { cls: "server-error",   re: /\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable|overloaded|server_error|upstream/i },
  { cls: "timeout",        re: /timed?[_ -]?out|timeout|deadline exceeded|ETIMEDOUT|request timeout/i },
  { cls: "network",        re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|socket connection .*closed|closed unexpectedly|connection (was )?(refused|reset|closed)|network error|fetch failed|getaddrinfo/i },
  { cls: "bad-request",    re: /\b400\b|bad request|invalid request|malformed|unprocessable|422/i },
];

const FS_RULES: Rule[] = [
  { cls: "fs-permission", re: /\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted/i },
  { cls: "fs-exists",     re: /\bEEXIST\b|already exists/i },
  { cls: "fs-space",      re: /\bENOSPC\b|no space left|disk (is )?full|quota exceeded/i },
  { cls: "fs-not-found",  re: /\bENOENT\b|no such file or directory|not a directory|\bENOTDIR\b/i },
  { cls: "fs-invalid",    re: /\bEISDIR\b|\bEINVAL\b|\bENAMETOOLONG\b|\bEROFS\b|read-only file system|invalid argument/i },
];

export function classifyError(text: string, code?: number, ctx?: "tool" | "request"): ErrClass {
  const t = text || "";
  if (typeof code === "number" && code < 0) return "killed";
  if (/SIGKILL|SIGTERM|out of memory|OOM|killed/i.test(t)) return "killed";
  if (ctx === "tool") {
    for (const r of FS_RULES) if (r.re.test(t)) return r.cls;
  }
  if (code === 127 || /command not found|not recognized|no such file or directory|ENOENT/i.test(t)) return "cli-missing";
  if (/^fatal:|not a git repository|nothing to commit|git\b.*fail/im.test(t)) return "git";
  for (const r of RULES) if (r.re.test(t)) return r.cls;
  for (const r of FS_RULES) if (r.re.test(t)) return r.cls;
  if (code === 137) return "killed";
  return t && /error|fail|exception/i.test(t) ? (ctx === "tool" ? "tool-error" : "unknown") : "unknown";
}

export function errExcerpt(text: string, max = 200): string {
  const lines = (text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const hit = lines.find((l) => RULES.some((r) => r.re.test(l)) || /error|fail|exception/i.test(l));
  const pick = hit || lines[lines.length - 1] || "";
  return pick.length > max ? pick.slice(0, max - 1) + "…" : pick;
}
