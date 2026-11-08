// Регресс fanout_batch (direct-spawn ×N, Path A). Прогон: node .omp/tools/_lib/fanout_batch.test.ts
// Реальный temp-git + ФЕЙК inner (пишет файлы + считает конкуренцию) — параллель/budget/isolation без claude.
import { fanoutBatch, runBudgeted, type BatchTask } from "./fanout_batch.ts";
import { ConcurrencyBudget, type ModelCaps } from "./modelcaps.ts";
import type { WorkerPi, WorkerReq, WorkerRes, InnerRunner } from "./backend.ts";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function makeExec(): WorkerPi["exec"] {
  return (cmd, args, opts) =>
    new Promise((res) => {
      execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        res({ code, stdout: stdout || "", stderr: stderr || "" });
      });
    });
}
async function initRepo(): Promise<{ dir: string; pi: WorkerPi }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
  const exec = makeExec();
  const g = (a: string[]) => exec("git", a, { cwd: dir });
  await g(["init", "-q"]); await g(["config", "user.email", "t@t.t"]); await g(["config", "user.name", "t"]);
  await g(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n"); await g(["add", "-A"]); await g(["commit", "-q", "-m", "seed"]);
  return { dir, pi: { cwd: dir, exec } };
}

let fails = 0;
const check = (n: string, c: boolean, got?: unknown) => { if (c) console.log(`  ok  ${n}`); else { console.log(`FAIL  ${n} got=${JSON.stringify(got)}`); fails++; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const caps = (byId: Record<string, number>, def = 4): ModelCaps => ({ defaultCap: def, byId });
const task = (id: string, model: string, zonePrefix: string): BatchTask<{ zone: string }> => ({
  id, model, meta: { zone: zonePrefix },
  req: { system: "", user: "", model, inZone: (f: string) => f.replace(/\\/g, "/").startsWith(zonePrefix) },
});

// --- 1. budget: per-model потолок соблюдён (qwen cap=1 → серийно; deepseek cap=4 → параллельно) ---
{
  const live: Record<string, number> = {}; const peak: Record<string, number> = {};
  const inner: InnerRunner = async (innerPi, req: WorkerReq) => {
    const m = req.model;
    live[m] = (live[m] || 0) + 1; peak[m] = Math.max(peak[m] || 0, live[m]);
    await sleep(40);
    live[m] = live[m] - 1;
    // пишем файл в зону "<model>/" — совпадает с zonePrefix задачи
    fs.mkdirSync(path.join(innerPi.cwd, m), { recursive: true });
    fs.writeFileSync(path.join(innerPi.cwd, m, "f.txt"), "x\n");
    return { code: 0, stdout: "ok", stderr: "" } as WorkerRes;
  };
  const { dir, pi } = await initRepo();
  const budget = new ConcurrencyBudget(caps({ qwen: 1, deepseek: 4 }));
  const tasks = [
    task("q1", "qwen", "qwen/"), task("q2", "qwen", "qwen/"),
    task("d1", "deepseek", "deepseek/"), task("d2", "deepseek", "deepseek/"), task("d3", "deepseek", "deepseek/"),
  ];
  const res = await fanoutBatch(pi, tasks, budget, inner);
  check("all 5 ok", res.every((r) => r.worker?.code === 0), res.map((r) => r.error));
  check("qwen peak concurrency = 1 (cap)", peak.qwen === 1, peak.qwen);
  check("deepseek ran parallel (>1)", peak.deepseek > 1, peak.deepseek);
  check("bring-back file exists", fs.existsSync(path.join(dir, "qwen", "f.txt")) && fs.existsSync(path.join(dir, "deepseek", "f.txt")));
  check("budget drained (all released)", budget.total() === 0, budget.total());
  check("worktrees cleaned", fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("omp-batch-")).length === 0, "leftover");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2. isolation: out-of-zone запись отброшена (не долетает до реального tree) ---
{
  const inner: InnerRunner = async (innerPi) => {
    fs.mkdirSync(path.join(innerPi.cwd, "good"), { recursive: true }); fs.writeFileSync(path.join(innerPi.cwd, "good", "a.txt"), "1\n");
    fs.mkdirSync(path.join(innerPi.cwd, "evil"), { recursive: true }); fs.writeFileSync(path.join(innerPi.cwd, "evil", "b.txt"), "2\n");
    return { code: 0, stdout: "", stderr: "" } as WorkerRes;
  };
  const { dir, pi } = await initRepo();
  const budget = new ConcurrencyBudget(caps({}, 2));
  const res = await fanoutBatch(pi, [task("t1", "m", "good/")], budget, inner);
  check("in-zone brought", res[0].brought.includes("good/a.txt"), res[0]);
  check("out-of-zone discarded", res[0].discarded.includes("evil/b.txt"), res[0]);
  check("evil NOT in real tree", !fs.existsSync(path.join(dir, "evil", "b.txt")));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 3. worker-fail проброшен, worktree очищен ---
{
  const inner: InnerRunner = async () => ({ code: 7, stdout: "", stderr: "boom" } as WorkerRes);
  const { dir, pi } = await initRepo();
  const res = await fanoutBatch(pi, [task("t1", "m", "z/")], new ConcurrencyBudget(caps({})), inner);
  check("worker-fail rc проброшен", res[0].worker?.code === 7, res[0]);
  check("worktrees cleaned после fail", fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("omp-batch-")).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 4. runBudgeted: порядок результатов = порядок входа, cap соблюдён ---
{
  const budget = new ConcurrencyBudget(caps({ a: 2 }));
  const order = await runBudgeted([1, 2, 3, 4], () => "a", budget, async (x) => { await sleep(10); return x * 10; });
  check("runBudgeted order preserved", JSON.stringify(order) === JSON.stringify([10, 20, 30, 40]), order);
}

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
