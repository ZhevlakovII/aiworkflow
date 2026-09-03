// modelroles — резолв/валидация привязки ролей OMP к моделям из models.yml (task-2).
// Задача: подкидывать дефолт-модели на роли из РЕАЛЬНОГО models.yml (не хардкод-Qwen шаблона) и
//   уведомлять, когда роль без модели ИЛИ модель не резолвится в models.yml (install-time + runtime).
// Self-contained (лёгкий парс, без yaml-dep) — импортится и воркерами (OMP-loader), и tools/setup_roles.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Роли, которые несёт machine-head config.yml modelRoles. Порядок = порядок опроса в binder'е.
export const ROLES = ["default", "smol", "slow", "producer", "critic", "explorer", "advisor"] as const;
export type Role = (typeof ROLES)[number];

// Маркер границы head↔product в config.yml (head = всё выше). Синхронно с install.ps1/sh.
export const PRODUCT_MARKER = "# ===== AIWORKFLOW PRODUCT";

export interface ModelRef { provider: string; id: string; full: string; }  // full = "provider/id"

function indentOf(line: string): number { return line.length - line.replace(/\t/g, "  ").trimStart().length; }
function markerIndex(text: string): number {
  for (const line of text.split("\n")) if (line.startsWith(PRODUCT_MARKER)) return text.indexOf(line);
  return -1;
}
function headOf(text: string): string { const i = markerIndex(text); return i >= 0 ? text.slice(0, i) : text; }

/** modelRoles из config-текста (только head, до PRODUCT_MARKER). Пустое значение = роль без модели. */
export function parseModelRoles(configText: string): Record<string, string> {
  const roles: Record<string, string> = {};
  let inBlock = false, blockIndent = -1;
  for (const raw of headOf(configText).split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (/^\s*modelRoles\s*:/.test(line)) { inBlock = true; blockIndent = indentOf(line); continue; }
    if (!inBlock) continue;
    if (line.trim() && indentOf(line) <= blockIndent) break;      // вышли из блока
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*(#.*)?$/);
    if (m) roles[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return roles;
}

/** Все модели из models.yml: providers.<name>.models[].id → {provider, id, full}. */
export function listModels(modelsText: string): ModelRef[] {
  const out: ModelRef[] = [];
  let provider = "", inProviders = false, provIndent = -1;
  for (const raw of modelsText.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const ind = indentOf(line);
    if (/^\s*providers\s*:/.test(line)) { inProviders = true; provIndent = ind; continue; }
    if (!inProviders) continue;
    if (ind <= provIndent) { inProviders = false; continue; }
    const pm = line.match(/^\s+([A-Za-z0-9_.-]+)\s*:\s*$/);
    if (pm && ind === provIndent + 2) { provider = pm[1]; continue; }
    const im = line.match(/^\s*-\s*id\s*:\s*([^\s#]+)/);
    if (im) { const id = im[1].trim(); out.push({ provider, id, full: provider ? `${provider}/${id}` : id }); }
  }
  return out;
}

/** Резолвится ли runtime-модель против списка id из models.yml (exact | provider/id | суффикс). */
export function modelResolves(models: ModelRef[], model: string): boolean {
  const m = (model || "").trim();
  if (!m) return false;
  return models.some((r) => m === r.id || m === r.full || m.endsWith("/" + r.id) || r.full.endsWith("/" + m));
}

export interface RoleIssue { role: string; model: string; reason: "unset" | "unknown-model"; }

/** Роли без модели / с моделью вне models.yml — для уведомления (install + runtime). */
export function unresolvedRoles(roles: Record<string, string>, models: ModelRef[]): RoleIssue[] {
  const out: RoleIssue[] = [];
  for (const r of ROLES) {
    const v = roles[r];
    if (v == null) continue;                                   // роль вовсе не объявлена — не наша забота здесь
    if (!v.trim()) out.push({ role: r, model: "", reason: "unset" });
    else if (!modelResolves(models, v)) out.push({ role: r, model: v, reason: "unknown-model" });
  }
  return out;
}

/** Собрать modelRoles-блок из назначений (роли в каноничном порядке; пустые = роль без модели). */
export function renderModelRoles(roles: Record<string, string>): string {
  return "modelRoles:\n" + ROLES.map((r) => `  ${r}: ${(roles[r] ?? "").trim()}`).join("\n") + "\n";
}

/** Переписать modelRoles-блок в head config-текста (preserve всё прочее: theme, MARKER, product-tail).
 *  Существующий блок удаляется, новый ставится на его место (или в начало head, если не было). */
export function writeModelRoles(configText: string, roles: Record<string, string>): string {
  const idx = markerIndex(configText);
  const head = idx >= 0 ? configText.slice(0, idx) : configText;
  const tail = idx >= 0 ? configText.slice(idx) : "";
  const newBlock = renderModelRoles(roles).trimEnd();

  const outLines: string[] = [];
  let skipping = false, blockIndent = -1, inserted = false;
  for (const raw of head.split("\n")) {
    if (!skipping && /^\s*modelRoles\s*:/.test(raw)) {          // начало старого блока → подменяем
      skipping = true; blockIndent = indentOf(raw);
      outLines.push(newBlock); inserted = true; continue;
    }
    if (skipping) {
      if (raw.trim() === "" || indentOf(raw) > blockIndent) continue;   // тело старого блока — выкидываем
      skipping = false;                                                 // следующий top-level ключ
    }
    outLines.push(raw);
  }
  let newHead = outLines.join("\n");
  if (!inserted) newHead = newBlock + "\n" + newHead;          // блока не было — в начало head
  if (!newHead.endsWith("\n")) newHead += "\n";
  return newHead + tail;
}

// --- loaders (cwd-контекст: проектный .omp → machine-head) ---

/** config.yml: machine-head (~/.omp/agent) — единственный носитель modelRoles. */
export function loadConfigText(): string {
  const p = path.join(os.homedir(), ".omp", "agent", "config.yml");
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; }
}

/** models.yml: проектный <cwd>/.omp/models.yml → machine-head ~/.omp/agent/models.yml. */
export function loadModelsText(cwd: string): string {
  for (const p of [path.resolve(cwd, ".omp/models.yml"), path.join(os.homedir(), ".omp", "agent", "models.yml")]) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, "utf8"); } catch { /* next */ }
  }
  return "";
}

/** Уведомление о нерезолвнутых ролях в текущем окружении (runtime/install). Пусто = всё ок / нет данных. */
export function checkRoles(cwd: string): RoleIssue[] {
  const cfg = loadConfigText();
  const models = listModels(loadModelsText(cwd));
  if (!cfg || !models.length) return [];
  return unresolvedRoles(parseModelRoles(cfg), models);
}

/** Runtime-префлайт модели для omp-backend'а: резолвится ли она в models.yml. Нет models.yml → не мешаем
 *  (LM Studio discovery / провайдер-дефолт могут работать без явного списка). Best-effort, не бросает. */
export function preflightModel(cwd: string, model: string): { ok: boolean; msg?: string } {
  try {
    const models = listModels(loadModelsText(cwd));
    if (!models.length) return { ok: true };
    if (!model || !model.trim()) return { ok: false, msg: "модель не задана (пустая) — omp упадёт" };
    if (modelResolves(models, model)) return { ok: true };
    const avail = models.slice(0, 4).map((m) => m.full).join(", ") + (models.length > 4 ? "…" : "");
    return { ok: false, msg: `модель '${model}' не найдена в models.yml (доступно: ${avail})` };
  } catch { return { ok: true }; }
}
