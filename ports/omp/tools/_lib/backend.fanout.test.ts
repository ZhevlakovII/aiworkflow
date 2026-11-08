// Регресс omp-fanout Path A (git-worktree изолятор). Прогон: node .omp/tools/_lib/backend.fanout.test.ts
// Node 24 стрипает типы. Реальный temp-git + ФЕЙК inner-runner (пишет файлы в worktree) — worktree/zone-
// логика проверяется БЕЗ claude. Валидирует: in-zone bring-back, out-of-zone discard (isolation), HEAD-prereq,
// inner-fail проброс, очистку worktree.
import { fanoutOrchestrate, type WorkerPi, type WorkerReq, type InnerRunner } from "./backend.ts";
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

async function initRepo(commit: boolean): Promise<{ dir: string; pi: WorkerPi }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-test-"));
  const exec = makeExec();
  const g = (args: string[]) => exec("git", args, { cwd: dir });
  await g(["init", "-q"]);
  await g(["config", "user.email", "t@t.t"]);
  await g(["config", "user.name", "t"]);
  await g(["config", "commit.gpgsign", "false"]);
  if (commit) {
    fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
    await g(["add", "-A"]);
    await g(["commit", "-q", "-m", "seed"]);
  }
  return { dir, pi: { cwd: dir, exec } };
}

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}

// inZone-предикат вместо zone-данных (см. backend.ts): тут — «файл под src/».
const srcOnly = (f: string) => f.replace(/\\/g, "/").startsWith("src/");
const req = (inZone?: WorkerReq["inZone"]): WorkerReq => ({ system: "", user: "", model: "x", inZone });

// --- 1. in-zone bring-back + out-of-zone discard (isolation load-bearing) ---
{
  const { dir, pi } = await initRepo(true);
  const inner: InnerRunner = async (innerPi) => {
    // пишем В зоне и ВНЕ зоны прямо в клон
    fs.mkdirSync(path.join(innerPi.cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(innerPi.cwd, "src", "good.kt"), "ok\n");
    fs.mkdirSync(path.join(innerPi.cwd, "evil"), { recursive: true });
    fs.writeFileSync(path.join(innerPi.cwd, "evil", "bad.kt"), "rogue\n");
    return { code: 0, stdout: "wrote 2", stderr: "" };
  };
  const r = await fanoutOrchestrate(pi, req(srcOnly), inner);
  check("rc 0", r.code === 0, r);
  check("in-zone долетел до реального tree", fs.existsSync(path.join(dir, "src", "good.kt")), r);
  check("out-of-zone ОТБРОШЕН (не в реальном tree)", !fs.existsSync(path.join(dir, "evil", "bad.kt")), r);
  check("stdout отметил discard", /ОТБРОШЕНО.*evil\/bad\.kt/.test(r.stdout), r.stdout);
  check("worktree очищен (нет omp-fanout-* в tmp)", fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("omp-fanout-")).length === 0, "leftover");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2. нет зоны → all bring-back (без фильтра) ---
{
  const { dir, pi } = await initRepo(true);
  const inner: InnerRunner = async (innerPi) => {
    fs.writeFileSync(path.join(innerPi.cwd, "anything.txt"), "x\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await fanoutOrchestrate(pi, req(), inner);
  check("no-zone: файл внесён", r.code === 0 && fs.existsSync(path.join(dir, "anything.txt")), r);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 3. HEAD-prereq: fresh репо без коммита → fail-closed ---
{
  const { dir, pi } = await initRepo(false);
  const inner: InnerRunner = async () => ({ code: 0, stdout: "", stderr: "" });
  const r = await fanoutOrchestrate(pi, req(srcOnly), inner);
  check("no-HEAD → fail-closed", r.code === 1 && /валидный HEAD/.test(r.stderr), r);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 4. inner-fail пробрасывается, worktree очищен ---
{
  const { dir, pi } = await initRepo(true);
  const inner: InnerRunner = async () => ({ code: 7, stdout: "", stderr: "boom" });
  const r = await fanoutOrchestrate(pi, req(srcOnly), inner);
  check("inner-fail: rc проброшен", r.code === 7, r);
  check("inner-fail: worktree очищен", fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("omp-fanout-")).length === 0, "leftover");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
