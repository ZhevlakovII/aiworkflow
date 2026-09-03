// Регресс modelcaps. Прогон: node .omp/tools/_lib/modelcaps.test.ts
// Проверяет: indent-парс maxSubagents (per-model + defaults), матч runtime-модели, ConcurrencyBudget.
import { parseModelCaps, matchCap, ConcurrencyBudget, DEFAULT_MAX_SUBAGENTS } from "./modelcaps.ts";

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}

const yaml = `
defaults:
  maxSubagents: 2
providers:
  lm-studio:
    baseUrl: http://localhost:1234/v1
    models:
      - id: qwen/qwen3.6-35b-a3b
        name: Qwen local
        maxSubagents: 1
  deepseek:
    models:
      - id: deepseek-chat
        name: DeepSeek
        maxSubagents: 4
      - id: deepseek-reasoner
        name: DeepSeek R
`;
const caps = parseModelCaps(yaml);
check("default cap", caps.defaultCap === 2, caps.defaultCap);
check("qwen cap=1", caps.byId["qwen/qwen3.6-35b-a3b"] === 1, caps.byId);
check("deepseek-chat cap=4", caps.byId["deepseek-chat"] === 4, caps.byId);
check("deepseek-reasoner unset (falls to default)", caps.byId["deepseek-reasoner"] === undefined, caps.byId);

// матч runtime-модели
check("match exact", matchCap(caps, "deepseek-chat") === 4);
check("match provider-prefixed", matchCap(caps, "lm-studio/qwen/qwen3.6-35b-a3b") === 1);
check("match unset → default", matchCap(caps, "deepseek-reasoner") === 2);
check("match unknown → default", matchCap(caps, "sonnet") === 2);

// пустой yaml → фолбэк
const empty = parseModelCaps("providers: {}");
check("empty default fallback", empty.defaultCap === DEFAULT_MAX_SUBAGENTS, empty.defaultCap);

// ConcurrencyBudget
const b = new ConcurrencyBudget(caps);
check("can dispatch qwen (0<1)", b.canDispatch("lm-studio/qwen/qwen3.6-35b-a3b"));
b.acquire("lm-studio/qwen/qwen3.6-35b-a3b");
check("qwen saturated (1/1)", !b.canDispatch("lm-studio/qwen/qwen3.6-35b-a3b"));
check("deepseek still free", b.canDispatch("deepseek-chat"));
b.acquire("deepseek-chat"); b.acquire("deepseek-chat");
check("deepseek 2/4 free", b.canDispatch("deepseek-chat"));
b.acquire("deepseek-chat"); b.acquire("deepseek-chat");
check("deepseek 4/4 saturated", !b.canDispatch("deepseek-chat"));
b.release("deepseek-chat");
check("deepseek after release free", b.canDispatch("deepseek-chat"));

// globalCap
const g = new ConcurrencyBudget(caps, 1);
g.acquire("deepseek-chat");
check("global cap blocks other model", !g.canDispatch("deepseek-reasoner"), g.total());

console.log(fails ? `\n${fails} FAIL` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
