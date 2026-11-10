// code_search — ast-index discovery multitool (P1).
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { ok, err } from "./_lib/result";
import { nodeExecPi, runAst } from "./_lib/astindex";

const CMDS = [
  "search",
  "symbol",
  "class",
  "usages",
  "implementations",
  "hierarchy",
  "refs",
  "deps",
  "dependents",
  "api",
] as const;

export function registerCodeSearch(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "code_search",
    description:
      "Discovery по коду через ast-index (дефолт вместо mass-grep). cmd: search, symbol, class, usages, " +
      "implementations, hierarchy, refs, deps, dependents, api.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", enum: [...CMDS], description: "подкоманда ast-index" },
        query: { type: "string", description: "символ / класс / имя / модуль" },
      },
      required: ["cmd", "query"],
    },
    async execute(params) {
      const q = String(params.query ?? "").trim();
      if (!q) return emitToolResult(err("пустой query"));
      const cmd = String(params.cmd ?? "");
      if (!(CMDS as readonly string[]).includes(cmd)) return emitToolResult(err(`неизвестный cmd: ${cmd}`));
      const r = await runAst(nodeExecPi, ctx.cwd, [cmd, q]);
      return emitToolResult(r.ok ? ok(r.text) : err(r.text));
    },
  });
}
