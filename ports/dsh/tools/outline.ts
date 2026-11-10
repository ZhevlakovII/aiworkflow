// outline — file structure via ast-index (P1).
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { ok, err } from "./_lib/result";
import { nodeExecPi, runAst } from "./_lib/astindex";

export function registerOutline(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "outline",
    description: "Структура файла: классы/функции/свойства + номера строк (ast-index). Зови перед чтением большого файла.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "repo-relative путь к файлу" },
      },
      required: ["file"],
    },
    async execute(params) {
      const f = String(params.file ?? "").trim();
      if (!f) return emitToolResult(err("пустой file"));
      const r = await runAst(nodeExecPi, ctx.cwd, ["outline", f]);
      return emitToolResult(r.ok ? ok(r.text) : err(r.text));
    },
  });
}
