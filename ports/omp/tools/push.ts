// gated_push — L2 push/PR-рельс, thin OMP-tool wrapper over
// core/src/rails/push.ts::gatedPush (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). git/gh through nodeGitSeam
// (sync, Bun-compatible) — same chokepoint invariant as commit.ts.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { railDeps, toToolResult } from "./_lib/rail";
import { gatedPush } from "../../../core/src/rails/push.ts";

const factory: CustomToolFactory = (pi) => {
  return {
    name: "gated_push",
    label: "Gated push",
    loadMode: "essential",
    description:
      "Единственный путь к push (raw `git push` заблокирован; `git merge` — отдельный merge-тул). " +
      "Core-рельс: ветка не protected, дерево чистое, есть коммиты вперёд → push -u; опц. PR через gh. " +
      "rail.level=none/beyond-reach (< push) → отказ. --dryRun проверяет гейты без реального push.",
    parameters: pi.zod.object({
      remote: pi.zod.string().optional().describe("remote (дефолт origin)"),
      protected: pi.zod.string().optional().describe("protected-ветки csv (дефолт main,master)"),
      pr: pi.zod.boolean().optional().describe("открыть PR через gh после push"),
      base: pi.zod.string().optional().describe("базовая ветка PR (дефолт main)"),
      title: pi.zod.string().optional(),
      body: pi.zod.string().optional(),
      dryRun: pi.zod.boolean().optional().describe("проверить гейты (protected/clean/ahead), не пушить"),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      const cwd = pi.cwd;
      const { policy, seam } = railDeps(cwd);

      const protectedBranches = params.protected
        ? params.protected.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        : undefined;

      const result = gatedPush({
        git: seam,
        policy,
        remote: params.remote,
        protectedBranches,
        dryRun: params.dryRun,
        pr: params.pr ? { base: params.base, title: params.title, body: params.body } : undefined,
      });
      return toToolResult(result);
    },
  };
};

export default factory;
