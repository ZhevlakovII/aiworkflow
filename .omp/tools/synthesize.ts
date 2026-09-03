// synthesize — one-shot: читает N спек, выделяет общие черты/расхождения/конфликты (P9 Track D).
// Утилита ВНЕ автономного контура. Сильная модель (claude -p) read-only мыслит; тул пишет synthesis-артефакт.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { runClaudeText } from "./_lib/claudetext";
import { ok, err } from "./_lib/result";

const SYS =
  "Ты — синтезатор (read-only). Читаешь НЕСКОЛЬКО спек/документов и выделяешь: общие черты и сквозные " +
  "требования, расхождения и конфликты между ними, уникальное у каждого, рекомендации по унификации. " +
  "Структурируй по секциям. Не выдумывай сверх источников — что не выведено, помечай явно.";

const factory: CustomToolFactory = (pi) => ({
  name: "synthesize",
  label: "One-shot synthesis (strong-model)",
  loadMode: "essential",
  description:
    "One-shot утилита (вне автономного контура): читает N спек/документов и выделяет общие черты, " +
    "расхождения, конфликты сильной моделью (claude -p, read-only). Пишет synthesis-артефакт, возвращает pointer.",
  parameters: pi.zod.object({
    specs: pi.zod.array(pi.zod.string()).describe("пути/glob'ы к спекам для синтеза (≥2)"),
    out: pi.zod.string().optional().describe("куда писать синтез (дефолт .workflow/synthesis-<date>.md)"),
    model: pi.zod.string().optional().describe("сильная модель (дефолт sonnet)"),
  }),
  async execute(_id, params) {
    if (!params.specs || params.specs.length < 2)
      return err("synthesize требует ≥2 источника (specs)");
    const model = params.model || "sonnet";
    const date = new Date().toISOString().slice(0, 10);
    const outRel = params.out || `.workflow/synthesis-${date}.md`;
    const outPath = path.resolve(pi.cwd, outRel);

    const list = params.specs.map((s) => `  - ${s}`).join("\n");
    const user =
      `Источники для синтеза (прочитай КАЖДЫЙ через Read; glob'ы разверни через Glob):\n${list}\n\n` +
      `Верни синтез в markdown: общие черты, расхождения/конфликты, уникальное, рекомендации.`;
    const r = await runClaudeText(pi, pi.cwd, model, SYS, user);
    if (r.code !== 0 || !r.text)
      return err(`claude rc=${r.code}\n${(r.stderr || "").slice(-1200)}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, r.text + "\n", "utf8");
    const cost = r.costUsd != null ? ` (~$${r.costUsd.toFixed(2)})` : "";
    const preview = r.text.length > 600 ? r.text.slice(0, 600) + "\n…(усечено, полный в файле)" : r.text;
    return ok(`SYNTHESIS → ${outRel}${cost} (${params.specs.length} источников)\n\n${preview}`);
  },
});

export default factory;
