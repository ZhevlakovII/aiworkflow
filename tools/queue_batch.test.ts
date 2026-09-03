// Регресс queue_batch (direct-spawn оркестратор). Прогон: node tools/queue_batch.test.ts
// Реальный temp-git + task-файлы + ФЕЙК inner (пишет по полю `write:` из task-body) — commit-rail/state
// без claude. Валидирует: committed (in-zone), gate-red (test-cmd), no-changes (вне-зоны discard).
import { runQueueBatch, type State } from "./queue_batch.ts";
import type { WorkerPi, WorkerReq, WorkerRes, InnerRunner } from "../.omp/tools/_lib/backend.ts";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const exec: WorkerPi["exec"] = (cmd, args, opts) =>
  new Promise((res) => execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => res({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: stdout || "", stderr: stderr || "" })));

let fails = 0;
const check = (n: string, c: boolean, got?: unknown) => { if (c) console.log(`  ok  ${n}`); else { console.log(`FAIL  ${n} got=${JSON.stringify(got)}`); fails++; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbatch-"));
const g = (a: string[]) => exec("git", a, { cwd: dir });
await g(["init", "-q"]); await g(["config", "user.email", "t@t.t"]); await g(["config", "user.name", "t"]); await g(["config", "commit.gpgsign", "false"]);
fs.writeFileSync(path.join(dir, "README.md"), "seed\n"); await g(["add", "-A"]); await g(["commit", "-q", "-m", "seed"]);

const tasksDir = path.join(dir, ".workflow/tasks");
fs.mkdirSync(tasksDir, { recursive: true });
const task = (id: string, allow: string, write: string, testCmd = "") =>
  fs.writeFileSync(path.join(tasksDir, `${id}.md`), `---\nid: ${id}\ncapability: cap-${id}\nstage: execute\nallow: ["${allow}"]\n${testCmd ? `test-cmd: ${testCmd}\n` : ""}---\nwrite: ${write}\n`);

task("ok1", "moda/**", "moda/f.kt");            // in-zone → committed
task("red1", "modb/**", "modb/f.kt", "false");  // test-cmd fails → gate-red blocked
task("out1", "modc/**", "evil/x.kt");           // пишет вне зоны → discard → no-changes blocked
// task-файлы должны быть в HEAD (worktree-клон берёт HEAD) — как в реальном репо (они трекаются).
await g(["add", "-A"]); await g(["commit", "-q", "-m", "tasks"]);

// fake inner: читает task-файл (taskRel из req.user), берёт `write:` путь, пишет его в клон.
const fakeInner: InnerRunner = async (innerPi: WorkerPi, req: WorkerReq): Promise<WorkerRes> => {
  const rel = (req.user.match(/контракта\): (\S+)/) || [])[1];
  if (!rel) return { code: 1, stdout: "", stderr: "no taskRel" };
  const text = fs.readFileSync(path.join(innerPi.cwd, rel), "utf8");
  const w = (text.match(/^write:\s*(\S+)/m) || [])[1];
  if (w) { fs.mkdirSync(path.dirname(path.join(innerPi.cwd, w)), { recursive: true }); fs.writeFileSync(path.join(innerPi.cwd, w), "code\n"); }
  return { code: 0, stdout: `wrote ${w}`, stderr: "" };
};

const pi: WorkerPi = { cwd: dir, exec };
const statePath = path.join(dir, ".workflow/queue-state.json");
const s = await runQueueBatch(pi, { cwd: dir, tasksDir, statePath, maxParallel: 3 }, fakeInner);

check("done=1 (ok1)", s.done === 1, s);
check("blocked=2 (red1,out1)", s.blocked === 2, s);
const st: State = JSON.parse(fs.readFileSync(statePath, "utf8"));
check("ok1 done", st.ok1 === "done", st);
check("red1 blocked", st.red1 === "blocked", st);
check("out1 blocked", st.out1 === "blocked", st);
check("ok1 committed in tree", fs.existsSync(path.join(dir, "moda", "f.kt")), "missing");
check("red1 NOT committed (reset)", (await g(["log", "--oneline"])).stdout.split("\n").filter((l) => /red1/.test(l)).length === 0);
check("commit has rail-подпись", /omp-rail:queue_batch/.test((await g(["log", "-1", "--format=%b"])).stdout), "no rail");
check("outcomes has gate-red + no-changes", !!s.outcomes["gate-red"] && !!s.outcomes["no-changes"], s.outcomes);
check("worktrees cleaned", fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("omp-batch-")).length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
