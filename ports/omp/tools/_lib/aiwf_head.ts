// aiwf_head — shared model head path, legacy migrate-once, seed-if-absent, OMP modelRoles mirror.
// ADR: AD-head-path-config-aiwf + AD-migrate-legacy-once (neutral head B).
// Resolve: AIWF_CONFIG_HOME -> XDG_CONFIG_HOME/aiwf -> ~/.config/aiwf (Windows: profile/.config/aiwf).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseModelRoles, writeModelRoles } from "./modelroles.ts";

// Local copy of marker (avoid circular init with modelroles loaders importing this module).
export const PRODUCT_MARKER_LINE = "# ===== AIWORKFLOW PRODUCT";
const PRODUCT_MARKER = PRODUCT_MARKER_LINE;

/** Env keys (documented). */
export const ENV_AIWF_CONFIG_HOME = "AIWF_CONFIG_HOME";
export const ENV_XDG_CONFIG_HOME = "XDG_CONFIG_HOME";

export interface HeadEnv {
  AIWF_CONFIG_HOME?: string | null;
  XDG_CONFIG_HOME?: string | null;
  HOME?: string | null;
  USERPROFILE?: string | null;
}

function envVal(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** User home: HOME, else USERPROFILE (Windows), else os.homedir(). */
export function userHome(env: HeadEnv = process.env): string {
  const h = envVal(env.HOME) || envVal(env.USERPROFILE);
  return h || os.homedir();
}

/**
 * Shared head directory (one site for all role->model readers).
 * 1) AIWF_CONFIG_HOME if set (full head dir)
 * 2) else $XDG_CONFIG_HOME/aiwf if XDG_CONFIG_HOME set
 * 3) else ~/.config/aiwf (Windows: profile + .config/aiwf, not %APPDATA%)
 */
export function resolveAiwfHeadDir(env: HeadEnv = process.env): string {
  const forced = envVal(env.AIWF_CONFIG_HOME);
  if (forced) return path.resolve(forced);
  const xdg = envVal(env.XDG_CONFIG_HOME);
  if (xdg) return path.resolve(xdg, "aiwf");
  return path.join(userHome(env), ".config", "aiwf");
}

/** OMP home agent dir (mirror target for modelRoles only; not SSOT after migrate). */
export function resolveHomeAgentDir(env: HeadEnv = process.env): string {
  return path.join(userHome(env), ".omp", "agent");
}

export function headModelsPath(headDir: string): string {
  return path.join(headDir, "models.yml");
}
export function headConfigPath(headDir: string): string {
  return path.join(headDir, "config.yml");
}
export function legacyModelsPath(agentDir: string): string {
  return path.join(agentDir, "models.yml");
}
export function legacyConfigPath(agentDir: string): string {
  return path.join(agentDir, "config.yml");
}

function readFile(p: string): string {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

function isNonEmptyText(t: string): boolean {
  return t.replace(/\s+/g, "").length > 0;
}

/** True if config head contains a modelRoles: key (even with empty role values). */
export function configHasModelRolesKey(configText: string): boolean {
  for (const raw of configText.split("\n")) {
    if (raw.startsWith(PRODUCT_MARKER)) break;
    if (/^\s*modelRoles\s*:/.test(raw)) return true;
  }
  return false;
}

/** Shared/legacy head present = non-empty models.yml OR config with modelRoles key. */
export function hasBinding(modelsText: string, configText: string): boolean {
  if (isNonEmptyText(modelsText)) return true;
  return configHasModelRolesKey(configText);
}

export function hasHeadBinding(headDir: string): boolean {
  return hasBinding(readFile(headModelsPath(headDir)), readFile(headConfigPath(headDir)));
}

export function hasLegacyBinding(agentDir: string): boolean {
  return hasBinding(readFile(legacyModelsPath(agentDir)), readFile(legacyConfigPath(agentDir)));
}

/** modelRoles payload only (no flavor product block). */
export function extractModelRolesPayload(configText: string): string {
  const roles = parseModelRoles(configText);
  if (!configHasModelRolesKey(configText) && Object.keys(roles).length === 0) return "";
  return writeModelRoles("", roles).trimEnd() + "\n";
}

/**
 * Sync modelRoles from shared head config into OMP home agent config.yml.
 * Preserves product block and other head keys; direction shared -> OMP only.
 */
export function syncModelRolesToOmp(
  sharedConfigText: string,
  ompConfigText: string,
): string {
  if (!configHasModelRolesKey(sharedConfigText) && Object.keys(parseModelRoles(sharedConfigText)).length === 0) {
    return ompConfigText;
  }
  return writeModelRoles(ompConfigText || "", parseModelRoles(sharedConfigText));
}

export function writeSyncModelRolesToOmp(headDir: string, agentDir: string): { wrote: boolean; path: string } {
  const sharedCfg = readFile(headConfigPath(headDir));
  const ompPath = legacyConfigPath(agentDir);
  if (!configHasModelRolesKey(sharedCfg)) return { wrote: false, path: ompPath };
  const next = syncModelRolesToOmp(sharedCfg, readFile(ompPath));
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(ompPath, next, "utf8");
  return { wrote: true, path: ompPath };
}

export type MigrateResult =
  | { status: "skipped-head-present"; headDir: string; imported: false; stripped: false }
  | { status: "skipped-no-legacy"; headDir: string; imported: false; stripped: false }
  | { status: "imported"; headDir: string; imported: true; stripped: boolean; models: boolean; roles: boolean }
  | { status: "dry-would-import"; headDir: string; imported: false; stripped: false; models: boolean; roles: boolean };

/**
 * One-shot legacy -> shared import when shared binding absent and legacy non-empty.
 * After successful copy: strip legacy models.yml only (keep modelRoles in OMP config for @role).
 * dryRun: report only, no writes.
 */
export function migrateLegacyOnce(opts: {
  headDir?: string;
  agentDir?: string;
  env?: HeadEnv;
  dryRun?: boolean;
}): MigrateResult {
  const env = opts.env ?? process.env;
  const headDir = opts.headDir ?? resolveAiwfHeadDir(env);
  const agentDir = opts.agentDir ?? resolveHomeAgentDir(env);
  if (hasHeadBinding(headDir)) {
    return { status: "skipped-head-present", headDir, imported: false, stripped: false };
  }
  const legModels = readFile(legacyModelsPath(agentDir));
  const legCfg = readFile(legacyConfigPath(agentDir));
  if (!hasBinding(legModels, legCfg)) {
    return { status: "skipped-no-legacy", headDir, imported: false, stripped: false };
  }
  const copyModels = isNonEmptyText(legModels);
  const copyRoles = configHasModelRolesKey(legCfg);
  if (opts.dryRun) {
    return { status: "dry-would-import", headDir, imported: false, stripped: false, models: copyModels, roles: copyRoles };
  }
  fs.mkdirSync(headDir, { recursive: true });
  let stripped = false;
  if (copyModels) {
    fs.writeFileSync(headModelsPath(headDir), legModels, "utf8");
  }
  if (copyRoles) {
    const payload = extractModelRolesPayload(legCfg);
    const existing = readFile(headConfigPath(headDir));
    const merged = writeModelRoles(existing, parseModelRoles(legCfg));
    fs.writeFileSync(headConfigPath(headDir), !existing ? payload : merged, "utf8");
  }
  if (copyModels) {
    try {
      fs.unlinkSync(legacyModelsPath(agentDir));
      stripped = true;
    } catch {
      stripped = false;
    }
  }
  return { status: "imported", headDir, imported: true, stripped, models: copyModels, roles: copyRoles };
}

export type SeedResult = {
  headDir: string;
  seededModels: boolean;
  seededRoles: boolean;
  keptModels: boolean;
  keptRoles: boolean;
};

/**
 * Seed shared head from templates when files/bindings absent. Never overwrite real bindings.
 */
export function seedSharedHeadIfAbsent(opts: {
  headDir?: string;
  modelsTpl: string;
  headTpl: string;
  env?: HeadEnv;
  dryRun?: boolean;
}): SeedResult {
  const env = opts.env ?? process.env;
  const headDir = opts.headDir ?? resolveAiwfHeadDir(env);
  const mPath = headModelsPath(headDir);
  const cPath = headConfigPath(headDir);
  const modelsAbsent = !isNonEmptyText(readFile(mPath));
  const rolesAbsent = !configHasModelRolesKey(readFile(cPath));
  const result: SeedResult = {
    headDir,
    seededModels: false,
    seededRoles: false,
    keptModels: !modelsAbsent,
    keptRoles: !rolesAbsent,
  };
  if (opts.dryRun) {
    result.seededModels = modelsAbsent;
    result.seededRoles = rolesAbsent;
    return result;
  }
  if (!modelsAbsent && !rolesAbsent) return result;
  fs.mkdirSync(headDir, { recursive: true });
  if (modelsAbsent) {
    const tpl = readFile(opts.modelsTpl);
    if (!tpl) throw new Error("models template missing: " + opts.modelsTpl);
    fs.writeFileSync(mPath, tpl, "utf8");
    result.seededModels = true;
    result.keptModels = false;
  }
  if (rolesAbsent) {
    const tpl = readFile(opts.headTpl);
    if (!tpl) throw new Error("head template missing: " + opts.headTpl);
    const existing = readFile(cPath);
    const next = existing ? tpl.trimEnd() + "\n" + existing : tpl;
    fs.writeFileSync(cPath, next.endsWith("\n") ? next : next + "\n", "utf8");
    result.seededRoles = true;
    result.keptRoles = false;
  }
  return result;
}

export type EnsureResult = {
  headDir: string;
  agentDir: string;
  migrate: MigrateResult;
  seed: SeedResult | null;
  synced: boolean;
  dryRun: boolean;
};

/**
 * Full setup path for resolving flows: migrate-once if needed, else seed-if-absent, then sync OMP mirror.
 */
export function ensureSharedHead(opts: {
  headDir?: string;
  agentDir?: string;
  modelsTpl: string;
  headTpl: string;
  env?: HeadEnv;
  dryRun?: boolean;
  skipSeed?: boolean;
}): EnsureResult {
  const env = opts.env ?? process.env;
  const headDir = opts.headDir ?? resolveAiwfHeadDir(env);
  const agentDir = opts.agentDir ?? resolveHomeAgentDir(env);
  const dryRun = !!opts.dryRun;
  const migrate = migrateLegacyOnce({ headDir, agentDir, env, dryRun });

  let seed: SeedResult | null = null;
  if (!opts.skipSeed) {
    const modelsAbsent = !isNonEmptyText(readFile(headModelsPath(headDir)));
    const rolesAbsent = !configHasModelRolesKey(readFile(headConfigPath(headDir)));
    if (dryRun && migrate.status === "dry-would-import") {
      const wouldModels = migrate.models ? false : modelsAbsent;
      const wouldRoles = migrate.roles ? false : rolesAbsent;
      if (wouldModels || wouldRoles) {
        seed = {
          headDir,
          seededModels: wouldModels,
          seededRoles: wouldRoles,
          keptModels: !wouldModels,
          keptRoles: !wouldRoles,
        };
      }
    } else if (modelsAbsent || rolesAbsent) {
      seed = seedSharedHeadIfAbsent({
        headDir,
        modelsTpl: opts.modelsTpl,
        headTpl: opts.headTpl,
        env,
        dryRun,
      });
    }
  }

  let synced = false;
  if (!dryRun) {
    synced = writeSyncModelRolesToOmp(headDir, agentDir).wrote;
  } else {
    synced =
      configHasModelRolesKey(readFile(headConfigPath(headDir))) ||
      migrate.status === "dry-would-import";
  }
  return { headDir, agentDir, migrate, seed, synced, dryRun };
}
