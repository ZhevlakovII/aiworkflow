// synthesize — one-shot: читает N спек, выделяет общие черты/расхождения/конфликты (порт OMP tools/synthesize.ts).
// Утилита ВНЕ автономного контура. Сильная модель (opencode run oneshot) read-only мыслит; тул пишет synthesis-артефакт.
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { runClaudeText } from "../lib/claudetext";
import { resolveStrongModel } from "../lib/modelroles";
import { ok, err } from "../lib/result";

const SYS =
  "Ты — синтезатор (read-only). Читаешь НЕСКОЛЬКО спек/документов и выделяешь: общие черты и сквозные " +
  "требования, расхождения и конфликты между ними, уникальное у каждого, рекомендации по унификации. " +
  "Структурируй по секциям. Не выдумывай сверх источников — что не выведено, помечай явно.";

export default tool({
  description:
    "One-shot утилита (вне автономного контура): читает N спек/документов и выделяет общие черты, " +
    "расхождения, конфликты сильной моделью (opencode run --agent aiwf-oneshot, read-only). Пишет synthesis-артефакт, возвращает pointer.",
  args: {
    specs: tool.schema.array(tool.schema.string()).describe("пути/glob'ы к спекам для синтеза (≥2)"),
    out: tool.schema.string().optional().describe("куда писать синтез (дефолт .workflow/synthesis-<date>.md)"),
    model: tool.schema.string().optional().describe("сильная модель (дефолт: OMP_PLAN_MODEL → modelRoles producer→slow→default)"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    if (!params.specs || params.specs.length < 2)
      return err("synthesize требует ≥2 источника (specs)");
    const model = (params.model || "").trim() || resolveStrongModel({ env: process.env.OMP_PLAN_MODEL });
    if (!model) return err("no model id: pass model arg, set OMP_PLAN_MODEL, or shared-head modelRoles producer/slow/default");
    const date = new Date().toISOString().slice(0, 10);
    const outRel = params.out || `.workflow/synthesis-${date}.md`;
    const outPath = path.resolve(cwd, outRel);

    const list = params.specs.map((s) => `  - ${s}`).join("\n");
    const user =
      `Источники для синтеза (прочитай КАЖДЫЙ через Read; glob'ы разверни через Glob):\n${list}\n\n` +
      `Верни синтез в markdown: общие черты, расхождения/конфликты, уникальное, рекомендации.`;
    const r = await runClaudeText(cwd, model, SYS, user);
    if (r.code !== 0 || !r.text)
      return err(`opencode oneshot rc=${r.code}\n${(r.stderr || "").slice(-1200)}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, r.text + "\n", "utf8");
    const cost = r.costUsd != null ? ` (~$${r.costUsd.toFixed(2)})` : "";
    const preview = r.text.length > 600 ? r.text.slice(0, 600) + "\n…(усечено, полный в файле)" : r.text;
    return ok(`SYNTHESIS → ${outRel}${cost} (${params.specs.length} источников)\n\n${preview}`);
  },
});
