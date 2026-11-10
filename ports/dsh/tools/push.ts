// gated_push — L2 push/PR rail (thin DSH tool → core/src/rails/push.ts).
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { railDeps, toToolResult } from "./_lib/rail";
import { gatedPush } from "../../../core/src/rails/push.ts";

export function registerGatedPush(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "gated_push",
    description:
      "Единственный путь к push (raw git push блокируется). Core: protected + clean tree + ahead → push -u; опц. PR.",
    parameters: {
      type: "object",
      properties: {
        remote: { type: "string" },
        protected: { type: "string", description: "csv protected branches" },
        pr: { type: "boolean" },
        base: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        dryRun: { type: "boolean" },
      },
    },
    async execute(params) {
      const cwd = ctx.cwd;
      const { policy, seam } = railDeps(cwd);
      const protectedBranches = params.protected
        ? String(params.protected)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const result = gatedPush({
        git: seam,
        policy,
        remote: params.remote as string | undefined,
        protectedBranches,
        dryRun: params.dryRun === true,
        pr: params.pr
          ? {
              base: params.base as string | undefined,
              title: params.title as string | undefined,
              body: params.body as string | undefined,
            }
          : undefined,
      });
      return emitToolResult(toToolResult(result));
    },
  });
}
