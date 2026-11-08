// astindex (порт OMP _lib/astindex.ts) — обёртка ast-index CLI для discovery-тулов (code_search/outline/callers).
// Аффорданс > инструкция: даём их как тулы → агент тянется к ним, не к mass-grep.
// Авто-обслуживание индекса: нет индекса → rebuild; есть → update (инкрементально). exec — через Bun `$` shim.
import { exec } from "./exec";

const CAP = 8000; // потолок вывода (ast может дампить много) — усечь с пометкой

/** Гарантирует свежий индекс: stats-fail → полный rebuild; иначе инкрементальный update. */
export async function ensureIndex(cwd: string): Promise<void> {
  const st = await exec("ast-index", ["stats"], { cwd });
  if (st.code !== 0) { await exec("ast-index", ["rebuild"], { cwd }); return; }
  await exec("ast-index", ["update"], { cwd }); // дёшево если нет изменений
}

/** Прогон ast-index подкоманды. Возвращает stdout (усечён до CAP) либо текст ошибки. */
export async function runAst(cwd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  await ensureIndex(cwd);
  const r = await exec("ast-index", args, { cwd });
  if (r.code !== 0)
    return { ok: false, text: `ast-index ${args.join(" ")} rc=${r.code}\n${(r.stderr || r.stdout || "").slice(-1200)}` };
  let out = (r.stdout || "").trim() || "(пусто — ничего не найдено)";
  if (out.length > CAP) out = out.slice(0, CAP) + "\n…(усечено; уточни запрос)";
  return { ok: true, text: out };
}
