// dshtext — one-shot strong-model text (plan/synthesize/archive reconcile).
// Best-effort nested `dsh` via ctx.exec or DSH_ONESHOT_BIN; fail-closed when unavailable.
import { nodeExecPi, type ExecPi } from "./astindex.ts";

export interface DshTextResult {
  code: number;
  text: string;
  costUsd?: number;
  stderr: string;
}

function extractNdjsonText(stdout: string): { text: string; costUsd?: number } {
  let cost = 0;
  let anyCost = false;
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(s);
    } catch {
      continue;
    }
    const msg = (j.message ?? j) as Record<string, unknown>;
    const u = msg.usage as Record<string, unknown> | undefined;
    const c = (u?.cost as Record<string, unknown> | undefined)?.total;
    if (c != null) {
      cost += Number(c);
      anyCost = true;
    }
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

function oneshotExecPi(ctxExec?: ExecPi["exec"]): ExecPi {
  if (ctxExec) return { exec: ctxExec };
  return nodeExecPi;
}

/** Run headless one-shot when DSH_ONESHOT=1 or host injects ctx.exec. */
export async function runDshText(
  cwd: string,
  model: string,
  system: string,
  user: string,
  ctxExec?: ExecPi["exec"],
): Promise<DshTextResult> {
  if (process.env.DSH_ONESHOT !== "1" && !ctxExec) {
    return {
      code: 1,
      text: "",
      stderr:
        "one-shot nested harness unavailable: set DSH_ONESHOT=1 and DSH_ONESHOT_BIN (default `dsh`) on PATH, " +
        "or use lead-native planning in-session.",
    };
  }
  const pi = oneshotExecPi(ctxExec);
  const bin = process.env.DSH_ONESHOT_BIN || "dsh";
  const combined = system.trim() ? `${system}\n\n---\n\n${user}` : user;
  const extra = (process.env.DSH_ONESHOT_ARGS || "").trim().split(/\s+/).filter(Boolean);
  const args = [
    ...extra,
    "-p",
    combined,
    "--model",
    model,
    "--mode",
    "json",
    "--tools",
    "Read,Glob,Grep",
    "--cwd",
    cwd,
    "--approval-mode",
    "yolo",
  ];
  const r = await pi.exec(bin, args, { cwd });
  const { text, costUsd } = extractNdjsonText(r.stdout);
  return { code: r.code, text, costUsd, stderr: r.stderr || "" };
}
