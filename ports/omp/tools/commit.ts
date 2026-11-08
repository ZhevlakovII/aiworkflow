// gated_commit — L1 commit-рельс, thin OMP-tool wrapper over
// core/src/rails/commit.ts::gatedCommit (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). git goes through nodeGitSeam
// (sync spawnSync, works under Bun), NOT pi.exec — the seam is its own
// enforcement chokepoint, zone-guard's bash-parsing surface never sees it,
// same invariant as the old pi.exec path (contract L-1).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { railDeps, resolveGateCmd, toToolResult } from "./_lib/rail";
import { gatedCommit } from "../../../core/src/rails/commit.ts";

const factory: CustomToolFactory = (pi) => {
  return {
    name: "gated_commit",
    label: "Gated commit",
    loadMode: "essential",
    description:
      "Единственный разрешённый путь к коммиту (raw `git commit` заблокирован). Core-рельс: `git add -A` → " +
      "zone-check staged (operator_zone) → quality-gate (явный --gate / зона task-file через design/gate-setup / " +
      "policy.quality_gate.cmd) → commit с трейлером [omp-rail:commit] только на зелёном. rail.level=none/beyond-reach → отказ.",
    parameters: pi.zod.object({
      message: pi.zod.string().describe("commit message"),
      gate: pi.zod
        .string()
        .optional()
        .describe("явная gate-команда — приоритет над зоной task-file и policy.quality_gate.cmd"),
      task: pi.zod
        .string()
        .optional()
        .describe(
          "путь к task-file — из его zone.allow/deny/test-cmd строится gate-команда (design/gate-setup), " +
            "используется только если --gate не задан"
        ),
      allowEmpty: pi.zod.boolean().optional().describe("git commit --allow-empty"),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      const cwd = pi.cwd;
      const gate = resolveGateCmd(cwd, params.gate, params.task);
      if (gate.error) return toToolResult({ ok: false, status: "guard-fail", detail: gate.error });

      const { policy, seam } = railDeps(cwd);
      const result = gatedCommit({
        git: seam,
        policy,
        message: params.message,
        allowEmpty: params.allowEmpty,
        gateCmd: gate.gateCmd,
        actor: "operator",
        repoRoot: cwd,
      });
      return toToolResult(result);
    },
  };
};

export default factory;
