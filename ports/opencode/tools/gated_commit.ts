// gated_commit — L1 commit-рельс, thin OpenCode-tool wrapper over
// core/src/rails/commit.ts::gatedCommit (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). git goes through nodeGitSeam
// (sync spawnSync, works under Bun), NOT Bun `$` — the seam is its own
// enforcement chokepoint, zone-guard plugin's bash-surface never sees it,
// same invariant as the old lib/exec path (contract L-1).
import { tool } from "@opencode-ai/plugin";
import { railDeps, resolveGateCmd, toToolResult } from "../lib/rail";
import { gatedCommit } from "../../../core/src/rails/commit.ts";

export default tool({
  description:
    "Единственный разрешённый путь к коммиту (raw `git commit` заблокирован). Core-рельс: `git add -A` → " +
    "zone-check staged (operator_zone) → quality-gate (явный gate / зона task-file через design/gate-setup / " +
    "policy.quality_gate.cmd) → commit с трейлером [omp-rail:commit] только на зелёном. rail.level=none/beyond-reach → отказ.",
  args: {
    message: tool.schema.string().describe("commit message"),
    gate: tool.schema
      .string()
      .optional()
      .describe("явная gate-команда — приоритет над зоной task-file и policy.quality_gate.cmd"),
    task: tool.schema
      .string()
      .optional()
      .describe(
        "путь к task-file — из его zone.allow/deny/test-cmd строится gate-команда (design/gate-setup), " +
          "используется только если gate не задан"
      ),
    allowEmpty: tool.schema.boolean().optional().describe("git commit --allow-empty"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
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
});
