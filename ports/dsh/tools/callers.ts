// callers — who calls a symbol (ast-index, P1).
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { ok, err } from "./_lib/result";
import { nodeExecPi, runAst } from "./_lib/astindex";

export function registerCallers(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "callers",
    description: "Кто зовёт символ/функцию (ast-index callers) — impact-анализ перед правкой.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "имя символа/функции" },
      },
      required: ["symbol"],
    },
    async execute(params) {
      const s = String(params.symbol ?? "").trim();
      if (!s) return emitToolResult(err("пустой symbol"));
      const r = await runAst(nodeExecPi, ctx.cwd, ["callers", s]);
      return emitToolResult(r.ok ? ok(r.text) : err(r.text));
    },
  });
}
