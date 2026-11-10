// gated_merge — L3 merge rail (thin DSH tool → core/src/rails/merge.ts).
import * as path from "node:path";
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { err } from "./_lib/result";
import { railDeps, resolveGateCmd, toToolResult } from "./_lib/rail";
import { gatedMerge } from "../../../core/src/rails/merge.ts";

export function registerGatedMerge(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "gated_merge",
    description:
      "Автономный merge (raw `git merge` заблокирован). CAPABILITY-PROBE: green-gate / clean-rebase / " +
      "forced-critic (feature,refactor) / rollback. security/migration — allowRisky. --dryRun после probe.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "feature-ветка для merge" },
        base: { type: "string", description: "базовая ветка (дефолт main/master)" },
        class: { type: "string", description: "класс: feature|refactor|trivial|security|migration" },
        findings: { type: "string", description: "critic findings-файл" },
        gate: { type: "string", description: "явная gate-команда на merge-результат" },
        task: { type: "string", description: "task-file для zone-gate" },
        allowRisky: { type: "boolean", description: "разрешить L3 для security/migration" },
        dryRun: { type: "boolean", description: "остановиться после capability-probe" },
      },
      required: ["branch"],
    },
    async execute(params) {
      const cwd = ctx.cwd;
      const gate = resolveGateCmd(cwd, params.gate as string | undefined, params.task as string | undefined);
      if (gate.error) return emitToolResult(err(gate.error));

      const { policy, seam } = railDeps(cwd);
      const result = gatedMerge({
        git: seam,
        policy,
        branch: String(params.branch ?? ""),
        base: params.base as string | undefined,
        klass: params.class as string | undefined,
        findingsPath: params.findings ? path.resolve(cwd, String(params.findings)) : undefined,
        gateCmd: gate.gateCmd,
        allowRisky: params.allowRisky === true,
        dryRun: params.dryRun === true,
      });
      return emitToolResult(toToolResult(result));
    },
  });
}
