// prereqs — hard/soft CLI probes for live flavors only.
// Contract: SP-exclude-claude-codex-ux — no claude/codex probe or install recipes.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export type PrereqKind = "hard" | "soft";

export type PrereqProbe = {
  id: string;
  kind: PrereqKind;
  /** CLI binary name on PATH (live flavors only). */
  cli: string;
  present: boolean;
};

/** Live-flavor harness CLIs only — never claude/codex. */
export const LIVE_PREREQ_CLIS = ["omp", "opencode", "cursor", "dsh"] as const;

/** Hard toolchain required for install/render. */
export const HARD_PREREQ_CLIS = ["git", "ast-index", "node"] as const;

function onPath(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8", shell: false });
  return (r.status ?? 1) === 0;
}

/** Cursor: PATH `cursor` or Windows LocalAppData Cursor.exe paths. */
export function isCursorPresent(): boolean {
  if (onPath("cursor")) return true;
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA;
    if (la) {
      for (const rel of ["Programs\\cursor\\Cursor.exe", "Programs\\Cursor\\Cursor.exe"]) {
        if (fs.existsSync(path.join(la, rel))) return true;
      }
    }
  }
  return false;
}

export function isHarnessPresent(id: string): boolean {
  if (id === "cursor") return isCursorPresent();
  return onPath(id);
}

/**
 * Probe hard + soft prerequisites for the installer.
 * Soft = live harness CLIs only (omp/opencode/cursor/dsh). No claude/codex.
 */
export async function probePrereqs(_opts?: {
  soft?: boolean;
}): Promise<PrereqProbe[]> {
  const hard: PrereqProbe[] = HARD_PREREQ_CLIS.map((cli) => ({
    id: cli,
    kind: "hard" as PrereqKind,
    cli,
    present: onPath(cli),
  }));
  const soft: PrereqProbe[] = LIVE_PREREQ_CLIS.map((cli) => ({
    id: cli,
    kind: "soft" as PrereqKind,
    cli,
    present: isHarnessPresent(cli),
  }));
  return [...hard, ...soft];
}

/** True if probe set contains a present CLI for id. */
export function isCliPresent(probes: readonly PrereqProbe[], id: string): boolean {
  return probes.some((p) => p.id === id && p.present);
}

/** Set of present soft harness ids (for softSkip). */
export function presentHarnessSet(probes: readonly PrereqProbe[]): Set<string> {
  const s = new Set<string>();
  for (const p of probes) {
    if (p.kind === "soft" && p.present) s.add(p.id);
  }
  return s;
}

/** Missing hard prereqs (git, ast-index, node). */
export function missingHard(probes: readonly PrereqProbe[]): string[] {
  return probes.filter((p) => p.kind === "hard" && !p.present).map((p) => p.id);
}
