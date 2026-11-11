// modelroles (OpenCode) — resolve for plan/synthesize/archive_spec defaults.
// Shared head (ADR AD-head-path-config-aiwf): AIWF_CONFIG_HOME -> XDG_CONFIG_HOME/aiwf -> ~/.config/aiwf.
// No home-agent-dir SSOT; no hard-coded last-resort model id (AD-opencode-native-oneshot).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PRODUCT_MARKER = "# ===== AIWORKFLOW PRODUCT";

function indentOf(line: string): number {
  return line.length - line.replace(/\t/g, "  ").trimStart().length;
}
function headOf(text: string): string {
  for (const line of text.split("\n")) {
    if (line.startsWith(PRODUCT_MARKER)) return text.slice(0, text.indexOf(line));
  }
  return text;
}

/** Shared head directory (ADR §1). env injectable for tests. */
export function resolveHeadDir(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): string {
  const override = String(env.AIWF_CONFIG_HOME ?? "").trim();
  if (override) return path.resolve(override);
  const xdg = String(env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg) return path.join(path.resolve(xdg), "aiwf");
  return path.join(os.homedir(), ".config", "aiwf");
}

export function parseModelRoles(configText: string): Record<string, string> {
  const roles: Record<string, string> = {};
  let inBlock = false, blockIndent = -1;
  for (const raw of headOf(configText).split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (/^\s*modelRoles\s*:/.test(line)) { inBlock = true; blockIndent = indentOf(line); continue; }
    if (!inBlock) continue;
    if (line.trim() && indentOf(line) <= blockIndent) break;
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*(#.*)?$/);
    if (m) roles[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return roles;
}

export function loadConfigText(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): string {
  const p = path.join(resolveHeadDir(env), "config.yml");
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; }
}

/**
 * Strong one-shot model id:
 *   tool env id (caller passes OMP_PLAN_MODEL) -> shared head producer -> slow -> default.
 * Empty string if none — callers must fail with "no model id" (no last-resort hardcode).
 */
export function resolveStrongModel(opts?: {
  env?: string | null;
  processEnv?: NodeJS.Dict<string> | NodeJS.ProcessEnv;
}): string {
  const fromEnv = (opts?.env ?? "").trim();
  if (fromEnv) return fromEnv;
  const roles = parseModelRoles(loadConfigText(opts?.processEnv ?? process.env));
  for (const k of ["producer", "slow", "default"] as const) {
    const v = (roles[k] || "").trim();
    if (v) return v;
  }
  return "";
}
