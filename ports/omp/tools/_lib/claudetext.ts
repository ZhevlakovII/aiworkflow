// claudetext — one-shot strong-model text (plan/synthesize, P9 Track D).
// B4: omp native exec (same argv shape as backend.ts omp branch); no pi.exec("claude").
// Модель читает (Read/Glob/Grep), МЫСЛИТ, возвращает markdown в stdout; тул сам пишет артефакт.

export interface ExecPi {
  exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ClaudeText {
  code: number;
  text: string;
  costUsd?: number;
  stderr: string;
}

/** Extract assistant text from omp --mode json NDJSON; fallback = raw stdout. */
function extractOmpText(stdout: string): { text: string; costUsd?: number } {
  let cost = 0;
  let anyCost = false;
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(s); } catch { continue; }
    const msg = (j.message ?? j) as Record<string, unknown>;
    const u = msg.usage as Record<string, unknown> | undefined;
    const c = (u?.cost as Record<string, unknown> | undefined)?.total;
    if (c != null) { cost += Number(c); anyCost = true; }
    // content may be string or array of {type,text}
    const content = msg.content ?? j.content ?? j.result ?? j.text;
    if (typeof content === "string" && content.trim()) parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string" && block.trim()) parts.push(block);
        else if (block && typeof block === "object" && typeof (block as { text?: string }).text === "string") {
          const t = (block as { text: string }).text;
          if (t.trim()) parts.push(t);
        }
      }
    }
  }
  const text = parts.length ? parts.join("\n").trim() : stdout.trim();
  return { text, costUsd: anyCost ? cost : undefined };
}

/** omp -p (read-only tools), --mode json. Same argv shape as backend omp branch. */
export async function runClaudeText(
  pi: ExecPi,
  cwd: string,
  model: string,
  system: string,
  user: string,
): Promise<ClaudeText> {
  const combined = system.trim() ? `${system}\n\n---\n\n${user}` : user;
  const tools = "Read,Glob,Grep";
  const r = await pi.exec(
    "omp",
    ["-p", combined, "--model", model, "--mode", "json", "--tools", tools, "--no-extensions",
     "--add-dir", cwd, "--cwd", cwd, "--approval-mode", "yolo"],
    { cwd },
  );
  const { text, costUsd } = extractOmpText(r.stdout);
  return { code: r.code, text, costUsd, stderr: r.stderr };
}
