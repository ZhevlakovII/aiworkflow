// code_search — нативный discovery-мультитул поверх ast-index (порт OMP tools/code_search.ts).
// ДЕФОЛТ для поиска по коду вместо mass-grep/чтения файлов. grep остаётся легит-fallback (без deny).
import { tool } from "@opencode-ai/plugin";
import { runAst } from "../lib/astindex";
import { ok, err } from "../lib/result";

const CMDS = [
  "search", "symbol", "class", "usages", "implementations",
  "hierarchy", "refs", "deps", "dependents", "api",
] as const;

export default tool({
  description:
    "Discovery по коду через ast-index (ДЕФОЛТ вместо mass-grep). cmd: search (свободный), symbol/class " +
    "(по имени), usages/refs (кто зовёт/юзает), implementations/hierarchy (что реализует/иерархия), " +
    "deps/dependents/api (модульные связи). Индекс авто-обслуживается.",
  args: {
    cmd: tool.schema.enum(CMDS).describe("подкоманда ast-index"),
    query: tool.schema.string().describe("символ / класс / имя / модуль для запроса"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const q = params.query.trim();
    if (!q) return err("пустой query");
    const r = await runAst(cwd, [params.cmd, q]);
    return r.ok ? ok(r.text) : err(r.text);
  },
});
