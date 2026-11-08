// gated_push — L2 push/PR-рельс, thin OpenCode-tool wrapper over
// core/src/rails/push.ts::gatedPush (B3 rebind,
// .workflow/tasks/phase-b3-rails-rebind.md). git/gh through nodeGitSeam
// (sync, Bun-compatible) — same chokepoint invariant as gated_commit.ts.
import { tool } from "@opencode-ai/plugin";
import { railDeps, toToolResult } from "../lib/rail";
import { gatedPush } from "../../../core/src/rails/push.ts";

export default tool({
  description:
    "Единственный путь к push (raw `git push` заблокирован; `git merge` — отдельный merge-тул). " +
    "Core-рельс: ветка не protected, дерево чистое, есть коммиты вперёд → push -u; опц. PR через gh. " +
    "rail.level=none/beyond-reach (< push) → отказ. dryRun проверяет гейты без реального push.",
  args: {
    remote: tool.schema.string().optional().describe("remote (дефолт origin)"),
    protected: tool.schema.string().optional().describe("protected-ветки csv (дефолт main,master)"),
    pr: tool.schema.boolean().optional().describe("открыть PR через gh после push"),
    base: tool.schema.string().optional().describe("базовая ветка PR (дефолт main)"),
    title: tool.schema.string().optional(),
    body: tool.schema.string().optional(),
    dryRun: tool.schema.boolean().optional().describe("проверить гейты (protected/clean/ahead), не пушить"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
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
});
