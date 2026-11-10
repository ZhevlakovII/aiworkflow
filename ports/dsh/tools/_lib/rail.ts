// rail — shared wiring for gated_commit/push/merge (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). Contract L-1/L-2: harness rails
// call core/src/rails/{commit,push,merge}.ts::gated* DIRECTLY via
// nodeGitSeam(cwd) (sync, Bun-compatible — no async pi.exec adapter), and
// load policy the SAME way core/src/rails/cli.ts does
// (core/src/wiring/policy-source.ts: loadPolicyFile -> buildPolicy), so the
// harness rails and the CC-native `core/src/rails/cli.ts` stay
// policy-consistent (same rail.level/quality_gate/merge_needs_human
// tiered-model, not the harness's old always-on behaviour).
import * as fs from "node:fs";
import * as path from "node:path";

import { nodeGitSeam, type GitSeam, type RailResult } from "../../../../core/src/rails/git-seam.ts";
import type { ResolvedPolicy } from "../../../../core/src/policy/policy.ts";
import { loadPolicyFile, buildPolicy, resolveInteractive } from "../../../../core/src/wiring/policy-source.ts";
import { buildGateSetup } from "../../../../core/src/design/gate-setup.ts";
import { ok, err } from "./result";

/** Policy load + GitSeam construction — same path/precedence as `core/src/rails/cli.ts`'s `prodDeps`. */
export function railDeps(cwd: string): { policy: ResolvedPolicy; seam: GitSeam } {
  const { policy } = loadPolicyFile((cwd || ".") + "/policy.yml");
  const { resolved } = buildPolicy({
    policy,
    interactive: resolveInteractive({ isTTY: process.stdout.isTTY === true }),
  });
  return { policy: resolved, seam: nodeGitSeam(cwd) };
}

/**
 * L-4 gate-cmd resolution: explicit tool param -> task-file zone-gate
 * (`design/task-zone.ts` + `design/gate-setup.ts`, B1) -> `undefined` (the
 * rail itself then falls back to `policy.quality_gate.cmd`). `.workflow/
 * gate.cmd` is no longer read (contract L-4) — it is a write-only artifact
 * of `design/gate-setup-cli.ts` / `design-stage.ts`'s design flow now.
 */
export function resolveGateCmd(
  cwd: string,
  explicitGate: string | undefined,
  taskPath: string | undefined
): { gateCmd?: string; error?: string } {
  if (explicitGate) return { gateCmd: explicitGate };
  if (!taskPath) return {};
  const tp = path.resolve(cwd, taskPath);
  if (!fs.existsSync(tp)) return { error: `task-file не найден: ${taskPath}` };
  const setup = buildGateSetup(fs.readFileSync(tp, "utf8"));
  if (setup.error) return { error: setup.error };
  return { gateCmd: setup.gateCmd };
}

/** `RailResult` -> tool-result (OMP `AgentToolResult` shape, `_lib/result.ts`). */
export function toToolResult(result: RailResult) {
  return result.ok ? ok(result.detail ?? result.status) : err(`${result.status}: ${result.detail ?? ""}`);
}
