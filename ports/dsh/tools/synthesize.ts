// synthesize — one-shot multi-spec synthesis (P2).
import * as fs from "node:fs";
import * as path from "node:path";
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { runDshText } from "./_lib/dshtext.ts";
import { ok, err } from "./_lib/result";

const SYS =
  "Ты — синтезатор (read-only). Читаешь НЕСКОЛЬКО спек и выделяешь: общие черты, расхождения/конфликты, " +
  "уникальное, рекомендации по унификации. Не выдумывай сверх источников.";

export function registerSynthesize(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "synthesize",
    description:
      "One-shot: N спек → synthesis-артефакт. Требует DSH_ONESHOT=1 или ctx.exec для nested harness.",
    parameters: {
      type: "object",
      properties: {
        specs: {
          type: "array",
          items: { type: "string" },
          description: "пути к спекам (≥2)",
        },
        out: { type: "string", description: "дефолт .workflow/synthesis-<date>.md" },
        model: { type: "string", description: "сильная модель (дефолт sonnet)" },
      },
      required: ["specs"],
    },
    async execute(params) {
      const specs = params.specs as string[] | undefined;
      if (!specs || specs.length < 2) return emitToolResult(err("synthesize требует ≥2 источника (specs)"));
      const cwd = ctx.cwd;
      const model = (params.model as string) || process.env.DSH_PLAN_MODEL || "sonnet";
      const date = new Date().toISOString().slice(0, 10);
      const outRel = (params.out as string) || `.workflow/synthesis-${date}.md`;
      const outPath = path.resolve(cwd, outRel);

      const list = specs.map((s) => `  - ${s}`).join("\n");
      const user =
        `Источники (прочитай КАЖДЫЙ; glob'ы через Glob):\n${list}\n\n` +
        `Верни синтез в markdown: общие черты, расхождения, уникальное, рекомендации.`;
      const r = await runDshText(cwd, model, SYS, user, ctx.exec);
      if (r.code !== 0 || !r.text) return emitToolResult(err(`dsh one-shot rc=${r.code}\n${(r.stderr || "").slice(-1200)}`));

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, r.text + "\n", "utf8");
      const cost = r.costUsd != null ? ` (~$${r.costUsd.toFixed(2)})` : "";
      const preview = r.text.length > 600 ? r.text.slice(0, 600) + "\n…(усечено, полный в файле)" : r.text;
      return emitToolResult(ok(`SYNTHESIS → ${outRel}${cost} (${specs.length} источников)\n\n${preview}`));
    },
  });
}
