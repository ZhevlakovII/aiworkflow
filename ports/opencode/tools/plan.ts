// plan — one-shot: читает спеку/задачу, строит step-by-step имплементационный план (порт OMP tools/plan.ts).
// Утилита ВНЕ автономного контура (не рельс, не гейт). Сильная модель (omp -p) read-only мыслит;
// тул детерминированно пишет план-артефакт.
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { runClaudeText } from "../lib/claudetext";
import { resolveStrongModel } from "../lib/modelroles";
import { ok, err } from "../lib/result";

const SYS =
  "Ты — планировщик (read-only). Читаешь спеку/задачу и строишь ПЛАН реализации — не реализуешь. " +
  "План содержит: упорядоченные шаги с зависимостями, критические файлы/модули, риски и развилки, " +
  "критерии готовности (Definition of Done). Не пиши код. Не выдумывай сверх спеки — неясности помечай явно.";

export default tool({
  description:
    "One-shot утилита (вне автономного контура): читает спеку/task-file и строит step-by-step " +
    "имплементационный план сильной моделью (omp -p, read-only). Пишет план-артефакт, возвращает pointer.",
  args: {
    spec: tool.schema.string().describe("путь к спеке/task-file для планирования"),
    out: tool.schema.string().optional().describe("куда писать план (дефолт .workflow/plans/<spec>-plan.md)"),
    model: tool.schema.string().optional().describe("сильная модель (дефолт: OMP_PLAN_MODEL → modelRoles producer→slow→default)"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const specPath = path.resolve(cwd, params.spec);
    if (!fs.existsSync(specPath)) return err("spec не найден: " + params.spec);
    const model = params.model || resolveStrongModel({ env: process.env.OMP_PLAN_MODEL });
    const base = path.basename(params.spec).replace(/\.md$/, "");
    const outRel = params.out || `.workflow/plans/${base}-plan.md`;
    const outPath = path.resolve(cwd, outRel);

    const user =
      `Спека/задача для планирования: ${params.spec}\n` +
      `Прочитай её через Read (и связанный контекст через Grep/Glob при необходимости). ` +
      `Верни план реализации в markdown.`;
    const r = await runClaudeText(cwd, model, SYS, user);
    if (r.code !== 0 || !r.text)
      return err(`omp rc=${r.code}\n${(r.stderr || "").slice(-1200)}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, r.text + "\n", "utf8");
    const cost = r.costUsd != null ? ` (~$${r.costUsd.toFixed(2)})` : "";
    const preview = r.text.length > 600 ? r.text.slice(0, 600) + "\n…(усечено, полный в файле)" : r.text;
    return ok(`PLAN → ${outRel}${cost}\n\n${preview}`);
  },
});
