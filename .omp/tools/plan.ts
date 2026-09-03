// plan — one-shot: читает спеку/задачу, строит step-by-step имплементационный план (P9 Track D).
// Утилита ВНЕ автономного контура (не рельс, не гейт): human просит план → lead зовёт этот тул.
// Сильная модель (claude -p) read-only мыслит; тул детерминированно пишет план-артефакт.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { runClaudeText } from "./_lib/claudetext";
import { ok, err } from "./_lib/result";

const SYS =
  "Ты — планировщик (read-only). Читаешь спеку/задачу и строишь ПЛАН реализации — не реализуешь. " +
  "План содержит: упорядоченные шаги с зависимостями, критические файлы/модули, риски и развилки, " +
  "критерии готовности (Definition of Done). Не пиши код. Не выдумывай сверх спеки — неясности помечай явно.";

const factory: CustomToolFactory = (pi) => ({
  name: "plan",
  label: "One-shot plan (strong-model)",
  loadMode: "essential",
  description:
    "One-shot утилита (вне автономного контура): читает спеку/task-file и строит step-by-step " +
    "имплементационный план сильной моделью (claude -p, read-only). Пишет план-артефакт, возвращает pointer.",
  parameters: pi.zod.object({
    spec: pi.zod.string().describe("путь к спеке/task-file для планирования"),
    out: pi.zod.string().optional().describe("куда писать план (дефолт .workflow/plans/<spec>-plan.md)"),
    model: pi.zod.string().optional().describe("сильная модель (дефолт sonnet)"),
  }),
  async execute(_id, params) {
    const specPath = path.resolve(pi.cwd, params.spec);
    if (!fs.existsSync(specPath)) return err("spec не найден: " + params.spec);
    const model = params.model || "sonnet";
    const base = path.basename(params.spec).replace(/\.md$/, "");
    const outRel = params.out || `.workflow/plans/${base}-plan.md`;
    const outPath = path.resolve(pi.cwd, outRel);

    const user =
      `Спека/задача для планирования: ${params.spec}\n` +
      `Прочитай её через Read (и связанный контекст через Grep/Glob при необходимости). ` +
      `Верни план реализации в markdown.`;
    const r = await runClaudeText(pi, pi.cwd, model, SYS, user);
    if (r.code !== 0 || !r.text)
      return err(`claude rc=${r.code}\n${(r.stderr || "").slice(-1200)}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, r.text + "\n", "utf8");
    const cost = r.costUsd != null ? ` (~$${r.costUsd.toFixed(2)})` : "";
    const preview = r.text.length > 600 ? r.text.slice(0, 600) + "\n…(усечено, полный в файле)" : r.text;
    return ok(`PLAN → ${outRel}${cost}\n\n${preview}`);
  },
});

export default factory;
