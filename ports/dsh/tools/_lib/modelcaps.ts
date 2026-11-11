// modelcaps — queue-runner concurrency (DSH paths).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MAX_SUBAGENTS = 1;

export interface ModelCaps {
  defaultCap: number;
  byId: Record<string, number>;
}

function resolveAiwfHeadDir(): string {
  const forced = (process.env.AIWF_CONFIG_HOME || "").trim();
  if (forced) return path.resolve(forced);
  const xdg = (process.env.XDG_CONFIG_HOME || "").trim();
  if (xdg) return path.resolve(xdg, "aiwf");
  return path.join(os.homedir(), ".config", "aiwf");
}
function modelsFiles(cwd: string): string[] {
  return [
    path.resolve(cwd, ".dsh-aiwf/models.yml"),
    path.join(resolveAiwfHeadDir(), "models.yml"),
  ];
}

const INT = /(-?\d+)/;

export function parseModelCaps(yaml: string): ModelCaps {
  const byId: Record<string, number> = {};
  let defaultCap = DEFAULT_MAX_SUBAGENTS;
  let inDefaults = false,
    defaultsIndent = -1;
  let lastId: string | null = null,
    idIndent = -1;

  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    const dm = line.match(/^(\s*)defaults\s*:/);
    if (dm) {
      inDefaults = true;
      defaultsIndent = dm[1].length;
      lastId = null;
      continue;
    }
    if (inDefaults && indent <= defaultsIndent) inDefaults = false;

    const idm = line.match(/^(\s*)-\s*id\s*:\s*([^\s#]+)/);
    if (idm) {
      idIndent = idm[1].length;
      lastId = idm[2].trim();
      inDefaults = false;
      continue;
    }

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

export function loadModelCaps(cwd: string): ModelCaps {
  for (const p of modelsFiles(cwd)) {
    try {
      if (fs.existsSync(p)) return parseModelCaps(fs.readFileSync(p, "utf8"));
    } catch {
      /* next */
    }
  }
  return { defaultCap: DEFAULT_MAX_SUBAGENTS, byId: {} };
}

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

export function resolveMaxSubagents(cwd: string, model: string): number {
  return matchCap(loadModelCaps(cwd), model);
}

export class ConcurrencyBudget {
  private inflight = new Map<string, number>();
  private caps: ModelCaps;
  private globalCap: number;
  constructor(caps: ModelCaps, globalCap = Infinity) {
    this.caps = caps;
    this.globalCap = globalCap;
  }

  count(key: string): number {
    return this.inflight.get(key) || 0;
  }
  total(): number {
    let t = 0;
    for (const v of this.inflight.values()) t += v;
    return t;
  }
  capFor(key: string): number {
    return matchCap(this.caps, key);
  }

  canDispatch(key: string): boolean {
    return this.total() < this.globalCap && this.count(key) < this.capFor(key);
  }
  acquire(key: string): void {
    this.inflight.set(key, this.count(key) + 1);
  }
  release(key: string): void {
    this.inflight.set(key, Math.max(0, this.count(key) - 1));
  }
}
