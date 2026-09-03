// modelcaps — резолв параллелизма на модель (task-3). Читает ~/.omp/agent/models.yml (machine-head)
//   ИЛИ проектный models.yml, достаёт per-model `maxSubagents` + `defaults.maxSubagents`.
// Зачем: queue-runner гонит N задач параллельно, но потолок задаёт РЕАЛЬНАЯ ёмкость провайдера
//   (локальный Qwen = 1 GPU-слот; remote API = больше). Без YAML-зависимости (лёгкий indent-парс,
//   как fromDelegationFile в backend.ts — bare-node тесты не резолвят yaml-пакет).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MAX_SUBAGENTS = 1;   // fail-safe: незаданная модель = 1 (последовательно, не перегружаем)

export interface ModelCaps {
  defaultCap: number;
  byId: Record<string, number>;           // id (как в models.yml) → maxSubagents
}

/** Пути models.yml по приоритету: проектный <cwd>/.omp/models.yml (если есть) → machine-head. */
function modelsFiles(cwd: string): string[] {
  return [
    path.resolve(cwd, ".omp/models.yml"),
    path.join(os.homedir(), ".omp", "agent", "models.yml"),
  ];
}

const INT = /(-?\d+)/;

/** Парс maxSubagents из текста models.yml. Indent-aware: `- id: X` открывает модель-блок;
 *  `maxSubagents: N` внутри него (отступ больше маркера) привязывается к последнему id. */
export function parseModelCaps(yaml: string): ModelCaps {
  const byId: Record<string, number> = {};
  let defaultCap = DEFAULT_MAX_SUBAGENTS;
  let inDefaults = false, defaultsIndent = -1;
  let lastId: string | null = null, idIndent = -1;

  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    // top-level `defaults:` блок
    const dm = line.match(/^(\s*)defaults\s*:/);
    if (dm) { inDefaults = true; defaultsIndent = dm[1].length; lastId = null; continue; }
    if (inDefaults && indent <= defaultsIndent) inDefaults = false;

    const idm = line.match(/^(\s*)-\s*id\s*:\s*([^\s#]+)/);
    if (idm) { idIndent = idm[1].length; lastId = idm[2].trim(); inDefaults = false; continue; }

    const cm = line.match(/^\s*maxSubagents\s*:\s*/);
    if (cm) {
      const n = line.match(INT);
      const v = n ? parseInt(n[1], 10) : NaN;
      if (Number.isFinite(v) && v > 0) {
        if (inDefaults) defaultCap = v;
        else if (lastId && indent > idIndent) byId[lastId] = v;
      }
    }
  }
  return { defaultCap, byId };
}

/** Читает first-existing models.yml → ModelCaps. Нет файла → только дефолт. */
export function loadModelCaps(cwd: string): ModelCaps {
  for (const p of modelsFiles(cwd)) {
    try {
      if (fs.existsSync(p)) return parseModelCaps(fs.readFileSync(p, "utf8"));
    } catch { /* следующий кандидат */ }
  }
  return { defaultCap: DEFAULT_MAX_SUBAGENTS, byId: {} };
}

/** Матч runtime-модели (напр. "lm-studio/qwen/qwen3.6-35b-a3b" или "sonnet") к id из models.yml.
 *  Приоритет: exact → runtime endsWith "/"+id → id — суффикс runtime → включение. */
export function matchCap(caps: ModelCaps, model: string): number {
  const m = (model || "").trim();
  if (caps.byId[m] != null) return caps.byId[m];
  const ids = Object.keys(caps.byId);
  const hit =
    ids.find((id) => m.endsWith("/" + id)) ??
    ids.find((id) => id.endsWith("/" + m)) ??
    ids.find((id) => m.includes(id) || id.includes(m));
  return hit ? caps.byId[hit] : caps.defaultCap;
}

/** Резолв потолка параллелизма для модели из models.yml (cwd-контекст). */
export function resolveMaxSubagents(cwd: string, model: string): number {
  return matchCap(loadModelCaps(cwd), model);
}

/** Учёт in-flight задач на модель — потолок дневает queue-runner. Чистый, тестируемый.
 *  key = модель (или любой bucket-ключ). canDispatch учитывает и per-key cap, и общий globalCap. */
export class ConcurrencyBudget {
  private inflight = new Map<string, number>();
  private caps: ModelCaps;
  private globalCap: number;
  constructor(caps: ModelCaps, globalCap = Infinity) { this.caps = caps; this.globalCap = globalCap; }

  count(key: string): number { return this.inflight.get(key) || 0; }
  total(): number { let t = 0; for (const v of this.inflight.values()) t += v; return t; }
  capFor(key: string): number { return matchCap(this.caps, key); }

  canDispatch(key: string): boolean {
    return this.total() < this.globalCap && this.count(key) < this.capFor(key);
  }
  acquire(key: string): void { this.inflight.set(key, this.count(key) + 1); }
  release(key: string): void { this.inflight.set(key, Math.max(0, this.count(key) - 1)); }
}
