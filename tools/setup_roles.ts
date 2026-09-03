// setup_roles — интерактивная привязка ролей OMP (modelRoles) к моделям из models.yml (task-2).
// Кросс-платформенно (node, вызывается из setup.ps1/setup.sh). Источник моделей = РЕАЛЬНЫЙ models.yml
// (не хардкод-Qwen шаблона). Пишет modelRoles в head config.yml, preserve всё прочее (theme/product).
//
// Режимы:
//   (default)   интерактив: по каждой роли выбрать модель из списка / keep / unset.
//   --defaults  без промптов: незарезолвнутые роли → дефолт-модель (первая в models.yml или --model X).
//   --check     только отчёт о нерезолвнутых ролях, НИЧЕГО не пишет (для setup -Check). exit 0.
//   --model X   дефолт-модель для --defaults / стартовое предложение в интерактиве.
//   --config P / --models P — переопределить пути (тест/нестандарт).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  ROLES, parseModelRoles, listModels, modelResolves, unresolvedRoles, writeModelRoles,
  type ModelRef,
} from "../.omp/tools/_lib/modelroles.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const home = os.homedir();
const configPath = arg("--config") || path.join(home, ".omp", "agent", "config.yml");
const modelsPath = arg("--models") || path.join(home, ".omp", "agent", "models.yml");
const wantCheck = has("--check");
const wantDefaults = has("--defaults");
const defModelArg = arg("--model");

function readOr(p: string): string { try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; } }

function reportIssues(roles: Record<string, string>, models: ModelRef[]): number {
  const issues = unresolvedRoles(roles, models);
  if (!issues.length) { console.log("  [ok] modelRoles: все роли резолвятся в models.yml."); return 0; }
  for (const i of issues) {
    if (i.reason === "unset") console.log(`  [warn] роль '${i.role}': МОДЕЛЬ НЕ ЗАДАНА (omp упадёт при её вызове).`);
    else console.log(`  [warn] роль '${i.role}': модель '${i.model}' НЕ найдена в models.yml.`);
  }
  return issues.length;
}

async function main(): Promise<number> {
  const models = listModels(readOr(modelsPath));
  const configText = readOr(configPath);
  const current = parseModelRoles(configText);

  console.log(`--- modelRoles bind (config: ${configPath}) ---`);
  if (!models.length) {
    console.log(`  [warn] в ${modelsPath} нет моделей — заполни его и перезапусти. Пропускаю привязку.`);
    return 0;
  }
  const defModel = defModelArg && modelResolves(models, defModelArg) ? defModelArg : models[0].full;

  // --check: только отчёт.
  if (wantCheck) { reportIssues(current, models); return 0; }

  const interactive = !wantDefaults && stdin.isTTY && stdout.isTTY;
  const bound: Record<string, string> = { ...current };

  if (!interactive) {
    // --defaults / не-TTY: незарезолвнутые роли → дефолт-модель; резолвнутые оставляем.
    if (!wantDefaults) console.log("  [note] не-интерактивный stdin → привязываю дефолты (--defaults-режим).");
    for (const r of ROLES) if (!modelResolves(models, bound[r] || "")) bound[r] = defModel;
    fs.writeFileSync(configPath, writeModelRoles(configText, bound), "utf8");
    console.log(`  [seed] незаданные роли → ${defModel}`);
    reportIssues(bound, models);
    return 0;
  }

  // Интерактив.
  console.log("Доступные модели из models.yml:");
  models.forEach((m, i) => console.log(`  ${i + 1}) ${m.full}`));
  console.log("Для каждой роли: номер модели | Enter = оставить текущее | u = снять (роль без модели).\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (const r of ROLES) {
      const cur = (current[r] || "").trim();
      const curOk = modelResolves(models, cur);
      const suggestion = curOk ? cur : defModel;
      const label = cur ? (curOk ? cur : `${cur} (НЕ в models.yml)`) : "(не задано)";
      const ans = (await rl.question(`  ${r} [текущее: ${label}] → предложение ${suggestion}: `)).trim();
      if (ans === "") { bound[r] = curOk ? cur : suggestion; }          // Enter — оставить/принять предложение
      else if (ans.toLowerCase() === "u") { bound[r] = ""; }            // снять
      else {
        const n = parseInt(ans, 10);
        if (Number.isInteger(n) && n >= 1 && n <= models.length) bound[r] = models[n - 1].full;
        else { console.log(`    ? не понял '${ans}' — оставляю ${suggestion}`); bound[r] = suggestion; }
      }
    }
  } finally { rl.close(); }

  fs.writeFileSync(configPath, writeModelRoles(configText, bound), "utf8");
  console.log(`\n  [written] modelRoles → ${configPath}`);
  reportIssues(bound, models);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("setup_roles error:", e?.message || e); process.exit(1); });
