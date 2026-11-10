// Zonemap skeleton regression. Прогон: node ports/dsh/tools/_lib/zonemap.test.ts
import { resolveAgent, loadZoneMap } from "./zonemap.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const zm = loadZoneMap(resolve(here, "../../zonemap.yml"));

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`);
    fails++;
  }
}

check("parse: empty map", zm.map.length === 0, zm.map.length);
check("parse: default null", zm.defaultAgent === "executor" || zm.defaultAgent == null, zm.defaultAgent);

const unknown = resolveAgent(["docs/**"], zm);
check("unknown → executor", unknown.agent === "executor" && !unknown.ambiguous, unknown);

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
