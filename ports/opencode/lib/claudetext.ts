// claudetext (порт OMP _lib/claudetext.ts) — запуск сильной модели как чистого ризонера, возврат ТЕКСТА.
// Для one-shot synthesis-тулов (plan/synthesize): модель читает (Read/Glob/Grep), МЫСЛИТ, возвращает
// markdown в stdout; тул сам пишет артефакт (детерминир. output-path). exec — через Bun `$` shim.
import { exec } from "./exec";

export interface ClaudeText {
  code: number;
  text: string;
  costUsd?: number;
  stderr: string;
}

/** claude -p (read-only tools), --output-format json → {result, total_cost_usd}. Возвращает result-текст. */
export async function runClaudeText(
  cwd: string,
  model: string,
  system: string,
  user: string,
): Promise<ClaudeText> {
  const r = await exec(
    "claude",
    ["-p", user, "--model", model, "--output-format", "json",
     "--append-system-prompt", system, "--allowedTools", "Read,Glob,Grep", "--add-dir", cwd],
    { cwd },
  );
  let text = r.stdout;
  let costUsd: number | undefined;
  try {
    const j = JSON.parse(r.stdout);
    text = typeof j.result === "string" ? j.result : r.stdout;
    costUsd = j.total_cost_usd;
  } catch { /* non-json → raw stdout */ }
  return { code: r.code, text: text.trim(), costUsd, stderr: r.stderr };
}
