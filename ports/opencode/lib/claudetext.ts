// claudetext (порт OMP _lib/claudetext.ts) — one-shot strong-model text (plan/synthesize, B4).
// omp native exec; xAI/provider ids from modelRoles work via OMP backend.
import { exec } from "./exec";

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

/** omp -p (read-only tools), --mode json. Same argv shape as OMP backend omp branch. */
export async function runClaudeText(
  cwd: string,
  model: string,
  system: string,
  user: string,
): Promise<ClaudeText> {
  const combined = system.trim() ? `${system}\n\n---\n\n${user}` : user;
  const tools = "Read,Glob,Grep";
  const r = await exec(
    "omp",
    ["-p", combined, "--model", model, "--mode", "json", "--tools", tools, "--no-extensions",
     "--add-dir", cwd, "--cwd", cwd, "--approval-mode", "yolo"],
    { cwd },
  );
  const { text, costUsd } = extractOmpText(r.stdout);
  return { code: r.code, text, costUsd, stderr: r.stderr };
}

/** omp -p prompt-only (no file tools) — archive_spec reconcile/dedupe. */
export async function runOmpReason(
  cwd: string,
  model: string,
  prompt: string,
): Promise<ClaudeText> {
  const r = await exec(
    "omp",
    ["-p", prompt, "--model", model, "--mode", "json", "--tools", "", "--no-extensions",
     "--add-dir", cwd, "--cwd", cwd, "--approval-mode", "yolo"],
    { cwd },
  );
  const { text, costUsd } = extractOmpText(r.stdout);
  return { code: r.code, text, costUsd, stderr: r.stderr };
}
