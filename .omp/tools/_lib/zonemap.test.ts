// Регресс zonemap-резолвера (P9 Track C). Прогон: node .omp/tools/_lib/zonemap.test.ts
// Node 24 нативно стрипает типы. Валидирует парс реального zonemap.yml + резолв доменов.
import { resolveAgent, loadZoneMap } from "./zonemap.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const zm = loadZoneMap(resolve(here, "../../zonemap.yml"));

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}

// парс
check("parse: 7 map entries", zm.map.length === 7, zm.map.length);
check("parse: default=executor", zm.defaultAgent === "executor", zm.defaultAgent);
check("parse: deny source", zm.denyDomain.includes("source/**"), zm.denyDomain);

// резолв
const kmp = resolveAgent(["core/money/**"], zm);
check("core/money → kmp-developer", kmp.agent === "kmp-developer" && !kmp.ambiguous, kmp);
check("core/money → tech=kmp", kmp.tech === "kmp", kmp);

const feat = resolveAgent(["features/transactions/impl/**"], zm);
check("features → kmp-developer", feat.agent === "kmp-developer", feat);

const go = resolveAgent(["bot/internal/core/**"], zm);
check("bot → go-developer", go.agent === "go-developer" && go.tech === "go", go);

const gradle = resolveAgent(["build-logic/plugins/src/**"], zm);
check("build-logic → gradle-developer", gradle.agent === "gradle-developer" && gradle.tech === "gradle" && !gradle.ambiguous, gradle);

const mixed = resolveAgent(["core/**", "bot/**"], zm);
check("mixed → ambiguous + default", mixed.ambiguous && mixed.agent === "executor" && mixed.matched.length === 2, mixed);

const unknown = resolveAgent(["docs/**"], zm);
check("unknown zone → default executor", unknown.agent === "executor" && !unknown.ambiguous && unknown.matched.length === 0, unknown);

const denied = resolveAgent(["source/app/**"], zm);
check("source → denied, no domain", denied.denied.includes("source/app/**") && denied.matched.length === 0, denied);

const wf = resolveAgent(["core/money/**", ".workflow/**"], zm);
check(".workflow ignored (not ambiguous)", wf.agent === "kmp-developer" && !wf.ambiguous, wf);

console.log(fails === 0 ? "\nALL GREEN" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
