// modelroles (DSH) — self-contained resolve for plan/synthesize/archive_spec defaults.
// Reads ~/.omp/agent/config.yml modelRoles (same head as OMP); no cross-port imports.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PRODUCT_MARKER = "# ===== AIWORKFLOW PRODUCT";

function indentOf(line: string): number { return line.length - line.replace(/\t/g, "  ").trimStart().length; }
function headOf(text: string): string {
  for (const line of text.split("\n")) {
    if (line.startsWith(PRODUCT_MARKER)) return text.slice(0, text.indexOf(line));
  }
  return text;
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

export function loadConfigText(): string {
  const p = path.join(os.homedir(), ".omp", "agent", "config.yml");
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; }
}

export const STRONG_MODEL_LAST_RESORT = "xai-oauth/grok-4.7";

export function resolveStrongModel(opts?: { env?: string | null }): string {
  const fromEnv = (opts?.env ?? "").trim();
  if (fromEnv) return fromEnv;
  const roles = parseModelRoles(loadConfigText());
  for (const k of ["producer", "slow", "default"] as const) {
    const v = (roles[k] || "").trim();
    if (v) return v;
  }
  return STRONG_MODEL_LAST_RESORT;
}
