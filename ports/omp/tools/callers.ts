// callers — focused discovery-тул (P9 Track A): кто зовёт символ/функцию (impact-анализ перед правкой).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runAst } from "./_lib/astindex";
import { ok, err } from "./_lib/result";

const factory: CustomToolFactory = (pi) => ({
  name: "callers",
  label: "Callers of symbol (ast-index)",
  loadMode: "essential",
  description:
    "Кто зовёт символ/функцию (ast-index callers) — impact-анализ ПЕРЕД правкой сигнатуры/поведения. " +
    "Для 'что реализует интерфейс' используй code_search cmd=implementations.",
  parameters: pi.zod.object({
    symbol: pi.zod.string().describe("имя символа/функции"),
  }),
  async execute(_id, params) {
    const s = params.symbol.trim();
    if (!s) return err("пустой symbol");
    const r = await runAst(pi, pi.cwd, ["callers", s]);
    return r.ok ? ok(r.text) : err(r.text);
  },
});

export default factory;
