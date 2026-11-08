// astindex — обёртка ast-index CLI для нативных OMP discovery-тулов (P9 Track A).
// Аффорданс > инструкция: даём code_search/outline/callers как тулы → агент тянется к ним, не к mass-grep.
// Тул авто-обслуживает индекс: нет индекса → rebuild; есть → update (инкрементально, свежесть после правок).
import type { ExecPi } from "./claudetext";

const CAP = 8000; // потолок вывода (ast может дампить много) — усечь с пометкой

/** Гарантирует свежий индекс: stats-fail → полный rebuild; иначе инкрементальный update. */
export async function ensureIndex(pi: ExecPi, cwd: string): Promise<void> {
  const st = await pi.exec("ast-index", ["stats"], { cwd });
  if (st.code !== 0) { await pi.exec("ast-index", ["rebuild"], { cwd }); return; }
  await pi.exec("ast-index", ["update"], { cwd }); // дёшево если нет изменений
}

/** Прогон ast-index подкоманды. Возвращает stdout (усечён до CAP) либо текст ошибки. */
export async function runAst(
  pi: ExecPi,
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  await ensureIndex(pi, cwd);
  const r = await pi.exec("ast-index", args, { cwd });
  if (r.code !== 0)
    return { ok: false, text: `ast-index ${args.join(" ")} rc=${r.code}\n${(r.stderr || r.stdout || "").slice(-1200)}` };
  let out = (r.stdout || "").trim() || "(пусто — ничего не найдено)";
  if (out.length > CAP) out = out.slice(0, CAP) + "\n…(усечено; уточни запрос)";
  return { ok: true, text: out };
}
