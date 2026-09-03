// Регресс telemetry. Прогон: node .omp/tools/_lib/telemetry.test.ts
// Проверяет: append run+guard в проектный NDJSON, валидный JSON, поля kind/ts.
import { recordRun, recordGuard } from "./telemetry.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tlm-"));
const proj = path.join(cwd, ".workflow/telemetry.ndjson");
const glob = path.join(os.homedir(), ".omp", "agent", "telemetry.ndjson");
const globBefore = fs.existsSync(glob) ? fs.statSync(glob).size : 0;

recordRun(cwd, { tool: "execute_worker", tid: "t1", stage: "execute", backend: "omp", outcome: "committed", durationMs: 1234, worker: { costUsd: 0.5, totalTok: 100 }, commit: "abc123" });
recordGuard(cwd, { event: "zone-violation", tid: "t1", tool: "execute_worker", backend: "omp", detail: "wrote out/foo" });

check("проектный файл создан", fs.existsSync(proj));
const lines = fs.readFileSync(proj, "utf8").trim().split("\n");
check("2 строки", lines.length === 2, lines.length);

const run = JSON.parse(lines[0]);
check("run kind", run.kind === "run", run.kind);
check("run ts есть", typeof run.ts === "string" && run.ts.includes("T"));
check("run outcome", run.outcome === "committed");
check("run worker.costUsd", run.worker?.costUsd === 0.5);
check("run commit", run.commit === "abc123");

const guard = JSON.parse(lines[1]);
check("guard kind", guard.kind === "guard", guard.kind);
check("guard event", guard.event === "zone-violation");
check("guard detail", guard.detail === "wrote out/foo");

// глобал тоже дописан (best-effort; проверяем что вырос ≥2 строк)
if (fs.existsSync(glob)) {
  const globAfter = fs.statSync(glob).size;
  check("глобал вырос", globAfter > globBefore, { globBefore, globAfter });
} else {
  check("глобал создан", false, "нет файла");
}

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
