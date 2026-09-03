// Регресс backend-резолвера + диспетчера (delegation per-stage). Прогон: node .omp/tools/_lib/backend.test.ts
// Node 24 нативно стрипает типы. Валидирует приоритет override, fail-closed, форму exec-команд.
import { resolveBackend, runWorker, type WorkerPi } from "./backend.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}
function throws(name: string, fn: () => void) {
  try { fn(); console.log(`FAIL  ${name}  (не бросил)`); fails++; }
  catch { console.log(`  ok  ${name}`); }
}

// tmp cwd без delegation.yml
const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bk-bare-"));
// tmp cwd с delegation.yml (design:omp execute:codex)
const withFile = fs.mkdtempSync(path.join(os.tmpdir(), "bk-file-"));
fs.mkdirSync(path.join(withFile, ".omp"), { recursive: true });
fs.writeFileSync(path.join(withFile, ".omp/delegation.yml"), "design: omp\nexecute: codex\n");

delete process.env.OMP_BACKEND_DESIGN;
delete process.env.OMP_BACKEND_EXECUTE;

// --- приоритет: default ---
check("default design=claude", resolveBackend("design", null, bare).backend === "claude");
check("default execute=claude", resolveBackend("execute", null, bare).backend === "claude");

// --- delegation.yml ---
check("file design=omp", resolveBackend("design", null, withFile).backend === "omp", resolveBackend("design", null, withFile));
check("file execute=codex", resolveBackend("execute", null, withFile).backend === "codex");
check("file source label", resolveBackend("design", null, withFile).source === "delegation.yml");

// --- env перебивает file ---
process.env.OMP_BACKEND_EXECUTE = "omp";
check("env > file", resolveBackend("execute", null, withFile).backend === "omp");
check("env source label", resolveBackend("execute", null, withFile).source.startsWith("env"));

// --- task-field перебивает env ---
process.env.OMP_BACKEND_EXECUTE = "omp";
check("task-field > env", resolveBackend("execute", "claude", withFile).backend === "claude");
check("task-field source", resolveBackend("execute", "claude", withFile).source === "task-file");
delete process.env.OMP_BACKEND_EXECUTE;

// --- fail-closed ---
throws("unknown backend throws", () => resolveBackend("execute", "bogus", bare));
throws("codex недопустим для design", () => resolveBackend("design", "codex", bare));
throws("omp-fanout недопустим для design", () => resolveBackend("design", "omp-fanout", bare));
check("omp-fanout допустим для execute", resolveBackend("execute", "omp-fanout", bare).backend === "omp-fanout");

// --- runWorker: форма exec-команд (mock pi) ---
function mockPi(): { pi: WorkerPi; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const pi: WorkerPi = {
    cwd: "/proj",
    async exec(cmd, args) { calls.push({ cmd, args }); return { code: 0, stdout: '{"total_cost_usd":0.5,"result":"ok"}', stderr: "" }; },
  };
  return { pi, calls };
}

const m1 = mockPi();
const r1 = await runWorker(m1.pi, "claude", { system: "SYS", user: "USR", model: "sonnet" });
check("claude cmd", m1.calls[0].cmd === "claude");
check("claude -p user", m1.calls[0].args.includes("-p") && m1.calls[0].args.includes("USR"));
check("claude append-system", m1.calls[0].args.includes("--append-system-prompt") && m1.calls[0].args.includes("SYS"));
check("claude cost parsed (usage)", r1.usage?.costUsd === 0.5, r1.usage);

const m2 = mockPi();
await runWorker(m2.pi, "omp", { system: "SYS", user: "USR", model: "qwen" });
check("omp cmd", m2.calls[0].cmd === "omp");
check("omp --mode json", m2.calls[0].args.includes("--mode") && m2.calls[0].args.includes("json"));
check("omp --no-extensions (воркер без customTools/gated_commit)", m2.calls[0].args.includes("--no-extensions"));
check("omp combined prompt (system+user)", m2.calls[0].args.some((a) => a.includes("SYS") && a.includes("USR")));

// omp usage-парс из NDJSON-стрима (session + 2 distinct responseId, дубли не считаем)
const ompNdjson = [
  '{"type":"session","id":"sess-123"}',
  '{"type":"message_start","message":{"responseId":"r1","usage":{"input":100,"output":20,"totalTokens":120,"cost":{"total":0.01},"duration":500}}}',
  '{"type":"message_end","message":{"responseId":"r1","usage":{"input":100,"output":20,"totalTokens":120,"cost":{"total":0.01}}}}',
  '{"type":"message_end","message":{"responseId":"r2","usage":{"input":50,"output":10,"totalTokens":60,"cost":{"total":0.02}}}}',
].join("\n");
const mOmp: WorkerPi = { cwd: "/p", async exec() { return { code: 0, stdout: ompNdjson, stderr: "" }; } };
const rOmp = await runWorker(mOmp, "omp", { system: "S", user: "U", model: "qwen" });
check("omp usage sessionId", rOmp.usage?.sessionId === "sess-123", rOmp.usage);
check("omp usage dedup responseId (не x2)", rOmp.usage?.inputTok === 150, rOmp.usage?.inputTok);
check("omp usage cost sum", Math.abs((rOmp.usage?.costUsd || 0) - 0.03) < 1e-9, rOmp.usage?.costUsd);

const m3 = mockPi();
await runWorker(m3.pi, "codex", { system: "SYS", user: "USR", model: "gpt-5-codex" });
check("codex exec", m3.calls[0].cmd === "codex" && m3.calls[0].args[0] === "exec");
check("codex sandbox", m3.calls[0].args.includes("--sandbox") && m3.calls[0].args.includes("workspace-write"));

// omp-fanout = Path A (git-worktree изолятор). Здесь проверяем ДИСПАТЧ (mockPi без реального fs/git);
// полное поведение worktree/zone-filter/discard — в backend.fanout.test.ts (реальный temp-git).
const m4 = mockPi();
await runWorker(m4.pi, "omp-fanout", { system: "", user: "USR", model: "x" });
check("omp-fanout: worktree-путь (git rev-parse HEAD первым)", m4.calls[0].cmd === "git" && m4.calls[0].args.join(" ") === "rev-parse HEAD", m4.calls[0]);
check("omp-fanout: inner=claude в клоне", m4.calls.some((c) => c.cmd === "claude"), m4.calls.map((c) => c.cmd));
check("omp-fanout: worktree add до inner", m4.calls.findIndex((c) => c.args.includes("worktree")) < m4.calls.findIndex((c) => c.cmd === "claude"), m4.calls.map((c) => c.cmd));

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
