// Регресс telemetry (DSH paths). Прогон: node ports/dsh/tools/_lib/telemetry.test.ts
import { recordRun, recordGuard } from "./telemetry.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`);
    fails++;
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tlm-"));
const proj = path.join(cwd, ".workflow/telemetry.ndjson");
const glob = path.join(os.homedir(), ".dsh", "agent", "telemetry.ndjson");
const globBefore = fs.existsSync(glob) ? fs.statSync(glob).size : 0;

recordRun(cwd, {
  tool: "execute_session",
  tid: "t1",
  stage: "execute",
  backend: "dsh",
  outcome: "committed",
  durationMs: 99,
});
recordGuard(cwd, { event: "zone-violation", tid: "t1", tool: "zone-guard", detail: "deny" });

check("project file", fs.existsSync(proj));
const lines = fs.readFileSync(proj, "utf8").trim().split("\n");
check("2 lines", lines.length === 2, lines.length);
const run = JSON.parse(lines[0]);
check("run kind", run.kind === "run");
check("run backend", run.backend === "dsh");

if (fs.existsSync(glob)) {
  check("global grew", fs.statSync(glob).size > globBefore);
}

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
