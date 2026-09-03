// claudetext — запуск claude -p как сильной модели, возврат ТЕКСТА (не файловых правок).
// Для one-shot synthesis-тулов (plan/synthesize, P9 Track D): claude читает (Read/Glob/Grep),
// МЫСЛИТ, возвращает markdown в stdout; тул сам пишет артефакт (детерминир. output-path, воркер не пишет).
// ToS-safe: официальный claude-бинарь аутентится сам (как design_worker).

export interface ExecPi {
  exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ClaudeText {
  code: number;
  text: string;
  costUsd?: number;
  stderr: string;
}

/** claude -p (read-only tools), --output-format json → {result, total_cost_usd}. Возвращает result-текст. */
export async function runClaudeText(
  pi: ExecPi,
  cwd: string,
  model: string,
  system: string,
  user: string,
): Promise<ClaudeText> {
  const r = await pi.exec(
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
