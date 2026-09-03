// Регресс errclass. Прогон: node .omp/tools/_lib/errclass.test.ts
// Проверяет: classifyError по сигнатурам/exit-code, scanRequestErrors по NDJSON-потоку с error-фреймом.
import { classifyError, errExcerpt, scanRequestErrors } from "./errclass.ts";

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}

const cases: [string, number | undefined, string][] = [
  ["Error: 401 Unauthorized (invalid api key)", 1, "auth"],
  ["HTTP 429 Too Many Requests: rate limit exceeded", 1, "rate-limit"],
  ["context_length_exceeded: maximum context length is 131072", 1, "context-length"],
  ["404 model not found: deepseek-chat", 1, "model-not-found"],
  ["503 Service Unavailable / upstream overloaded", 1, "server-error"],
  ["connect ECONNREFUSED 127.0.0.1:1234", 1, "network"],
  ["request timed out after 60000ms", 1, "timeout"],
  ["command not found: codex", 127, "cli-missing"],
  ["fatal: not a git repository", 1, "git"],
  ["some totally unrelated failure blah", 1, "unknown"],
];
for (const [t, c, exp] of cases) {
  const g = classifyError(t, c);
  check(`classify ${exp}`, g === exp, g);
}

check("errExcerpt trims", errExcerpt("line1\n503 upstream overloaded here\nlast").includes("503"), errExcerpt("line1\n503 upstream overloaded here\nlast"));

// omp-like NDJSON: session + 2 успешных usage-фрейма + 1 error-фрейм + stderr-строка = 2 request-ошибки.
const stream = [
  '{"type":"session","id":"s1"}',
  '{"message":{"responseId":"r1","usage":{"input":10,"output":5}}}',
  '{"type":"error","error":{"status":429,"message":"rate limit"}}',
  '{"message":{"responseId":"r2","usage":{"input":8,"output":3}}}',
  "stderr: connect ETIMEDOUT",
].join("\n");
const sc = scanRequestErrors(stream);
check("scan count=2", sc.count === 2, sc.count);
check("scan class rate-limit", sc.classes.includes("rate-limit"), sc.classes);
check("scan class timeout (ETIMEDOUT)", sc.classes.includes("timeout"), sc.classes);
check("scan clean stream = 0", scanRequestErrors('{"message":{"responseId":"r1","usage":{"input":1}}}').count === 0);

console.log(fails ? `\n${fails} FAIL` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
