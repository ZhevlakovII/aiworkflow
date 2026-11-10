// Регресс modelroles. Прогон: node .omp/tools/_lib/modelroles.test.ts
// Проверяет: parseModelRoles, listModels, modelResolves, unresolvedRoles, writeModelRoles (preserve).
import {
  parseModelRoles, listModels, modelResolves, unresolvedRoles, writeModelRoles, renderModelRoles, ROLES,
  resolveStrongModel, STRONG_MODEL_LAST_RESORT,
} from "./modelroles.ts";

let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}  got=${JSON.stringify(got)}`); fails++; }
}

const config = `# machine head
modelRoles:
  default:  lm-studio/qwen/qwen3.6-35b-a3b
  smol:     lm-studio/qwen/qwen3.6-35b-a3b
  slow:
  producer: lm-studio/qwen/qwen3.6-35b-a3b
  critic:   lm-studio/qwen/qwen3.6-35b-a3b
  explorer: lm-studio/qwen/qwen3.6-35b-a3b
  advisor:  bogus/model-x   # pinned
theme:
  name: dark
# ===== AIWORKFLOW PRODUCT (managed) =====
extensions:
  - ./.omp/hooks/pre/zone-guard.ts
`;

const models = `providers:
  lm-studio:
    baseUrl: http://localhost:1234/v1
    models:
      - id: qwen/qwen3.6-35b-a3b
        name: Qwen
  deepseek:
    models:
      - id: deepseek-chat
        name: DeepSeek
`;

const roles = parseModelRoles(config);
check("parse default", roles.default === "lm-studio/qwen/qwen3.6-35b-a3b", roles.default);
check("parse slow empty", roles.slow === "", roles.slow);
check("parse advisor (strip comment)", roles.advisor === "bogus/model-x", roles.advisor);
check("parse stops at theme (no 'name' role)", roles.name === undefined, roles.name);

const ms = listModels(models);
check("list 2 models", ms.length === 2, ms.map((m) => m.full));
check("list full provider/id", ms[0].full === "lm-studio/qwen/qwen3.6-35b-a3b", ms[0].full);
check("list deepseek", ms[1].full === "deepseek/deepseek-chat", ms[1].full);

check("resolves full", modelResolves(ms, "lm-studio/qwen/qwen3.6-35b-a3b"));
check("resolves bare id", modelResolves(ms, "deepseek-chat"));
check("not resolves bogus", !modelResolves(ms, "bogus/model-x"));
check("not resolves empty", !modelResolves(ms, ""));

const issues = unresolvedRoles(roles, ms);
check("2 issues (slow unset, advisor unknown)", issues.length === 2, issues);
check("slow unset", issues.some((i) => i.role === "slow" && i.reason === "unset"));
check("advisor unknown-model", issues.some((i) => i.role === "advisor" && i.reason === "unknown-model"));

// writeModelRoles: подменить блок, СОХРАНИВ theme + PRODUCT tail
const bound: Record<string, string> = {};
for (const r of ROLES) bound[r] = "deepseek/deepseek-chat";
const out = writeModelRoles(config, bound);
check("preserves theme", out.includes("theme:") && out.includes("name: dark"), out);
check("preserves product marker", out.includes("# ===== AIWORKFLOW PRODUCT"), out);
check("preserves product body", out.includes("zone-guard.ts"));
check("rebound default", parseModelRoles(out).default === "deepseek/deepseek-chat", parseModelRoles(out).default);
check("rebound slow now set", parseModelRoles(out).slow === "deepseek/deepseek-chat");
check("no dup modelRoles", (out.match(/^modelRoles:/gm) || []).length === 1, (out.match(/^modelRoles:/gm) || []).length);
check("re-validate clean", unresolvedRoles(parseModelRoles(out), ms).length === 0);

// insert when absent
const noRoles = "theme:\n  name: light\n# ===== AIWORKFLOW PRODUCT\nextensions: []\n";
const ins = writeModelRoles(noRoles, bound);
check("insert modelRoles when absent", (ins.match(/^modelRoles:/gm) || []).length === 1, ins);
check("insert keeps theme", ins.includes("name: light"));

// resolveStrongModel
check("resolveStrongModel env wins", resolveStrongModel({ env: "custom/provider" }) === "custom/provider");
check("resolveStrongModel trims env", resolveStrongModel({ env: "  x/y  " }) === "x/y");
check("resolveStrongModel empty env falls through", resolveStrongModel({ env: "   " }) !== "");
check("STRONG_MODEL_LAST_RESORT", STRONG_MODEL_LAST_RESORT === "xai-oauth/grok-4.7");

function strongFromRoles(roles: Record<string, string>): string {
  for (const k of ["producer", "slow", "default"] as const) {
    const v = (roles[k] || "").trim();
    if (v) return v;
  }
  return STRONG_MODEL_LAST_RESORT;
}
const roleCfg = `modelRoles:\n  producer: prod/m\n  slow: slow/m\n  default: def/m\n`;
check("role chain producer", strongFromRoles(parseModelRoles(roleCfg)) === "prod/m");
const roleCfg2 = `modelRoles:\n  producer:\n  slow: slow-only\n  default: def/m\n`;
check("role chain slow skip empty producer", strongFromRoles(parseModelRoles(roleCfg2)) === "slow-only");
const roleCfg3 = `modelRoles:\n  producer:\n  slow:\n  default: def-only\n`;
check("role chain default", strongFromRoles(parseModelRoles(roleCfg3)) === "def-only");
check("ROLES includes scaffolder", ROLES.includes("scaffolder"));

console.log(fails ? `\n${fails} FAIL` : "\nALL GREEN");
process.exit(fails ? 1 : 0);
