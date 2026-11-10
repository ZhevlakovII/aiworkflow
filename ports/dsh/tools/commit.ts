// gated_commit — L1 commit rail (thin DSH tool → core/src/rails/commit.ts).
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { ok, err } from "./_lib/result";
import { railDeps, resolveGateCmd, toToolResult } from "./_lib/rail";
import { gatedCommit } from "../../../core/src/rails/commit.ts";

export function registerGatedCommit(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "gated_commit",
    description:
      "Единственный разрешённый путь к коммиту (raw git commit блокируется zone-guard). " +
      "Core: git add -A → zone-check staged → test-cmd → commit на зелёном.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "commit message" },
        gate: { type: "string", description: "явная gate-команда" },
        task: { type: "string", description: "путь к task-file для zone/test-cmd" },
        allowEmpty: { type: "boolean" },
      },
      required: ["message"],
    },
    async execute(params) {
      const cwd = ctx.cwd;
      const message = String(params.message ?? "");
      const gate = resolveGateCmd(cwd, params.gate as string | undefined, params.task as string | undefined);
      if (gate.error) return emitToolResult(err(gate.error));
      const { policy, seam } = railDeps(cwd);
      const result = gatedCommit({
        git: seam,
        policy,
        message,
        allowEmpty: params.allowEmpty === true,
        gateCmd: gate.gateCmd,
        actor: "operator",
        repoRoot: cwd,
      });
      return emitToolResult(toToolResult(result));
    },
  });
}
