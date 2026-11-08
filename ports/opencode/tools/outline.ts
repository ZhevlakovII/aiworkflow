// outline — focused discovery-тул (порт OMP tools/outline.ts): структура файла ДО чтения (символы + строки).
// Правило: перед чтением большого файла — outline, читать точечно, не весь файл вслепую.
import { tool } from "@opencode-ai/plugin";
import { runAst } from "../lib/astindex";
import { ok, err } from "../lib/result";

export default tool({
  description:
    "Структура файла через ast-index: классы/функции/свойства + номера строк. Зови ПЕРЕД чтением " +
    "большого файла — потом читай точечно нужный диапазон, не весь файл.",
  args: {
    file: tool.schema.string().describe("путь к файлу (repo-relative)"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const f = params.file.trim();
    if (!f) return err("пустой file");
    const r = await runAst(cwd, ["outline", f]);
    return r.ok ? ok(r.text) : err(r.text);
  },
});
