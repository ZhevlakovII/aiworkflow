// plan — one-shot implementation plan (P2 parity; outside autonomous queue).
import * as fs from "node:fs";
import * as path from "node:path";
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { runDshText } from "./_lib/dshtext.ts";
import { resolveStrongModel } from "./_lib/modelroles.ts";
import { ok, err } from "./_lib/result";

const SYS =
  "Ты — планировщик (read-only). Читаешь спеку/задачу и строишь ПЛАН реализации — не реализуешь. " +
  "План: шаги с зависимостями, критические файлы, риски, DoD. Не пиши код. Неясности помечай явно.";

export function registerPlan(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "plan",
    description:
      "One-shot (вне автоконтура): спека/task-file → step-by-step план в .workflow/plans/. " +
      "Требует DSH_ONESHOT=1 или ctx.exec для nested harness.",
    parameters: {
      type: "object",
      properties: {
        spec: { type: "string", description: "путь к спеке/task-file" },
        out: { type: "string", description: "куда писать план (дефолт .workflow/plans/<spec>-plan.md)" },
        model: { type: "string", description: "сильная модель (дефолт: DSH_PLAN_MODEL → modelRoles producer→slow→default)" },
      },
      required: ["spec"],
    },
    async execute(params) {
      const cwd = ctx.cwd;
      const specPath = path.resolve(cwd, String(params.spec));
      if (!fs.existsSync(specPath)) return emitToolResult(err("spec не найден: " + params.spec));
      const model = (params.model as string) || resolveStrongModel({ env: process.env.DSH_PLAN_MODEL });
      const base = path.basename(String(params.spec)).replace(/\.md$/, "");
      const outRel = (params.out as string) || `.workflow/plans/${base}-plan.md`;
      const outPath = path.resolve(cwd, outRel);

      const user =
        `Спека/задача для планирования: ${params.spec}\n` +
        `Прочитай через Read (и Grep/Glob при необходимости). Верни план в markdown.`;
      const r = await runDshText(cwd, model, SYS, user, ctx.exec);
      if (r.code !== 0 || !r.text) return emitToolResult(err(`dsh one-shot rc=${r.code}\n${(r.stderr || "").slice(-1200)}`));

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, r.text + "\n", "utf8");
      const cost = r.costUsd != null ? ` (~$${r.costUsd.toFixed(2)})` : "";
      const preview = r.text.length > 600 ? r.text.slice(0, 600) + "\n…(усечено, полный в файле)" : r.text;
      return emitToolResult(ok(`PLAN → ${outRel}${cost}\n\n${preview}`));
    },
  });
}
