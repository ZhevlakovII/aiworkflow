// callers — focused discovery-тул (порт OMP tools/callers.ts): кто зовёт символ/функцию (impact-анализ).
import { tool } from "@opencode-ai/plugin";
import { runAst } from "../lib/astindex";
import { ok, err } from "../lib/result";

export default tool({
  description:
    "Кто зовёт символ/функцию (ast-index callers) — impact-анализ ПЕРЕД правкой сигнатуры/поведения. " +
    "Для 'что реализует интерфейс' используй code_search cmd=implementations.",
  args: {
    symbol: tool.schema.string().describe("имя символа/функции"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const s = params.symbol.trim();
    if (!s) return err("пустой symbol");
    const r = await runAst(cwd, ["callers", s]);
    return r.ok ? ok(r.text) : err(r.text);
  },
});
