// outline — focused discovery-тул (P9 Track A): структура файла ДО чтения (символы + строки).
// Правило (ast-index rule): перед чтением большого файла — outline, читать точечно, не весь файл вслепую.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runAst } from "./_lib/astindex";
import { ok, err } from "./_lib/result";

const factory: CustomToolFactory = (pi) => ({
  name: "outline",
  label: "File outline (ast-index)",
  loadMode: "essential",
  description:
    "Структура файла через ast-index: классы/функции/свойства + номера строк. Зови ПЕРЕД чтением " +
    "большого файла — потом читай точечно нужный диапазон, не весь файл.",
  parameters: pi.zod.object({
    file: pi.zod.string().describe("путь к файлу (repo-relative)"),
  }),
  async execute(_id, params) {
    const f = params.file.trim();
    if (!f) return err("пустой file");
    const r = await runAst(pi, pi.cwd, ["outline", f]);
    return r.ok ? ok(r.text) : err(r.text);
  },
});

export default factory;
