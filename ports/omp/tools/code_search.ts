// code_search — нативный discovery-мультитул поверх ast-index (P9 Track A).
// ДЕФОЛТ для поиска по коду вместо mass-grep/чтения файлов. Гибрид-гранулярность:
// этот мультитул покрывает редкие подкоманды; частые outline/callers — отдельные focused-тулы.
// grep остаётся легит-fallback (soft, без deny) — там где ast не покрывает (комменты вне символов).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runAst } from "./_lib/astindex";
import { ok, err } from "./_lib/result";

// Подкоманды ast-index, принимающие <query> (символ/класс/имя/модуль).
const CMDS = [
  "search", "symbol", "class", "usages", "implementations",
  "hierarchy", "refs", "deps", "dependents", "api",
] as const;

const factory: CustomToolFactory = (pi) => ({
  name: "code_search",
  label: "Code search (ast-index)",
  loadMode: "essential",
  description:
    "Discovery по коду через ast-index (ДЕФОЛТ вместо mass-grep). cmd: search (свободный), symbol/class " +
    "(по имени), usages/callers/refs (кто зовёт/юзает), implementations/hierarchy (что реализует/иерархия), " +
    "deps/dependents/api (модульные связи). Индекс авто-обслуживается. source/** — устаревшее, игнорируй в выдаче.",
  parameters: pi.zod.object({
    cmd: pi.zod.enum(CMDS).describe("подкоманда ast-index"),
    query: pi.zod.string().describe("символ / класс / имя / модуль для запроса"),
  }),
  async execute(_id, params) {
    const q = params.query.trim();
    if (!q) return err("пустой query");
    const r = await runAst(pi, pi.cwd, [params.cmd, q]);
    return r.ok ? ok(r.text) : err(r.text);
  },
});

export default factory;
