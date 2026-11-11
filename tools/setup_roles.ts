// setup_roles — bind modelRoles to models from shared head models.yml (neutral head B).
// Cross-platform (node; called from setup.ps1/setup.sh). Writes modelRoles to shared head
// config.yml, then syncs modelRoles into home agent dir config.yml for OMP @role.
//
// Modes:
//   (default)   interactive: pick model per role / keep / unset.
//   --defaults  no prompts: unresolved roles -> default model (first in models.yml or --model X).
//   --check     report only, writes nothing (setup -Check). exit 0.
//   --model X   default model for --defaults / interactive suggestion.
//   --config P / --models P — override paths (test/nonstandard).
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  ROLES, parseModelRoles, listModels, modelResolves, unresolvedRoles, writeModelRoles,
  type ModelRef,
} from "../ports/omp/tools/_lib/modelroles.ts";
import {
  resolveAiwfHeadDir, resolveHomeAgentDir, headConfigPath, headModelsPath,
  writeSyncModelRolesToOmp,
} from "../ports/omp/tools/_lib/aiwf_head.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const headDir = resolveAiwfHeadDir();
const configPath = arg("--config") || headConfigPath(headDir);
const modelsPath = arg("--models") || headModelsPath(headDir);
const wantCheck = has("--check");
const wantDefaults = has("--defaults");
const defModelArg = arg("--model");

function readOr(p: string): string { try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } }

function reportIssues(roles: Record<string, string>, models: ModelRef[]): number {
  const issues = unresolvedRoles(roles, models);
  if (!issues.length) { console.log("  [ok] modelRoles: all roles resolve in models.yml."); return 0; }
  for (const i of issues) {
    if (i.reason === "unset") console.log("  [warn] role " + JSON.stringify(i.role) + ": MODEL UNSET.");
    else console.log("  [warn] role " + JSON.stringify(i.role) + ": model " + JSON.stringify(i.model) + " NOT in models.yml.");
  }
  return issues.length;
}

function persistRoles(configText: string, next: Record<string, string>): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, writeModelRoles(configText, next), "utf8");
  writeSyncModelRolesToOmp(headDir, resolveHomeAgentDir());
}

async function main(): Promise<number> {
  const models = listModels(readOr(modelsPath));
  const configText = readOr(configPath);
  const current = parseModelRoles(configText);

  console.log("--- modelRoles bind (config: " + configPath + ") ---");
  if (!models.length) {
    console.log("  [warn] no models in " + modelsPath + " — fill it and re-run. Skipping bind.");
    return 0;
  }
  const defModel = defModelArg && modelResolves(models, defModelArg) ? defModelArg : models[0].full;

  if (wantCheck) { reportIssues(current, models); return 0; }

  const interactive = !wantDefaults && stdin.isTTY && stdout.isTTY;
  const next: Record<string, string> = { ...current };

  if (!interactive) {
    if (!wantDefaults) console.log("  [note] non-interactive stdin -> defaults mode.");
    for (const r of ROLES) if (!modelResolves(models, next[r] || "")) next[r] = defModel;
    persistRoles(configText, next);
    console.log("  [seed] unset roles -> " + defModel);
    reportIssues(next, models);
    return 0;
  }

  console.log("Models from models.yml:");
  models.forEach((m, i) => console.log("  " + (i + 1) + ") " + m.full));
  console.log("Per role: model number | Enter = keep | u = unset." + String.fromCharCode(10));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (const r of ROLES) {
      const cur = (current[r] || "").trim();
      const curOk = modelResolves(models, cur);
      const suggestion = curOk ? cur : defModel;
      const label = cur ? (curOk ? cur : cur + " (NOT in models.yml)") : "(unset)";
      const ans = (await rl.question("  " + r + " [current: " + label + "] -> suggest " + suggestion + ": ")).trim();
      if (ans === "") { next[r] = curOk ? cur : suggestion; }
      else if (ans.toLowerCase() === "u") { next[r] = ""; }
      else {
        const n = parseInt(ans, 10);
        if (Number.isInteger(n) && n >= 1 && n <= models.length) next[r] = models[n - 1].full;
        else { console.log("    ? unknown " + JSON.stringify(ans) + " — keeping " + suggestion); next[r] = suggestion; }
      }
    }
  } finally { rl.close(); }

  persistRoles(configText, next);
  console.log(String.fromCharCode(10) + "  [written] modelRoles -> " + configPath);
  console.log("  [sync] modelRoles -> home agent config.yml");
  reportIssues(next, models);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("setup_roles error:", e?.message || e); process.exit(1); });
