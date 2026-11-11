// claudetext (OpenCode) — one-shot strong-model text (plan/synthesize/archive reason).
// AD-opencode-native-oneshot: opencode run --agent aiwf-oneshot|aiwf-reason. Never shells the omp binary.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "./exec";

export interface ClaudeText {
  code: number;
  text: string;
  costUsd?: number;
  stderr: string;
}

export const AGENT_ONESHOT = "aiwf-oneshot";
export const AGENT_REASON = "aiwf-reason";

const NO_MODEL =
  "no model id: pass tool arg model, set OMP_PLAN_MODEL, or set shared-head modelRoles producer/slow/default";

/** Extract assistant text from NDJSON/JSON lines (content / result / text); fallback = raw stdout. */
function extractOneshotText(stdout: string): { text: string; costUsd?: number } {
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

function fail(msg: string): ClaudeText {
  return { code: 1, text: "", stderr: msg };
}

/** Port install root: <dest> when this file lives at <dest>/lib/claudetext.ts. */
function installRootFromMeta(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..");
  } catch {
    return null;
  }
}

function opencodeConfigDirs(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const xdg = String(env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg) out.push(path.join(path.resolve(xdg), "opencode"));
  out.push(path.join(os.homedir(), ".config", "opencode"));
  return out;
}

/** Candidate paths for an installed flavor agent markdown. */
export function agentCandidatePaths(
  cwd: string,
  agent: string,
  env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env,
): string[] {
  const name = agent + ".md";
  const paths: string[] = [
    path.join(cwd, ".opencode", "agents", name),
  ];
  const root = installRootFromMeta();
  if (root) paths.push(path.join(root, "agents", name));
  for (const d of opencodeConfigDirs(env)) paths.push(path.join(d, "agents", name));
  return paths;
}

export function findInstalledAgent(
  cwd: string,
  agent: string,
  env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env,
): string | null {
  for (const p of agentCandidatePaths(cwd, agent, env)) {
    try { if (fs.existsSync(p)) return p; } catch { /* continue */ }
  }
  return null;
}

function opencodeOnPath(): string | null {
  try {
    const bun = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun;
    const w = bun && bun.which;
    if (typeof w === "function") {
      const hit = w.call(bun, "opencode");
      return hit ? hit : null;
    }
  } catch { /* fall through */ }
  return null;
}

async function ensureOpencodeBinary(): Promise<ClaudeText | null> {
  if (opencodeOnPath()) return null;
  const probe = process.platform === "win32"
    ? await exec("where", ["opencode"])
    : await exec("sh", ["-c", "command -v opencode"]);
  if (probe.code === 0 && probe.stdout.trim()) return null;
  return fail("opencode not found on PATH (OpenCode oneshot requires the opencode binary; no omp fallback)");
}

async function runOpencodeOneshot(
  cwd: string,
  model: string,
  agent: string,
  prompt: string,
): Promise<ClaudeText> {
  const id = (model || "").trim();
  if (!id) return fail(NO_MODEL);

  const missingBin = await ensureOpencodeBinary();
  if (missingBin) return missingBin;

  if (!findInstalledAgent(cwd, agent)) {
    return fail(
      "missing installed agent " + JSON.stringify(agent) +
      " (expected agents/" + agent + ".md under project .opencode or OpenCode config dest)",
    );
  }

  const args = ["run", "--model", id, "--agent", agent, prompt];
  const argvShape = "opencode run --model " + id + " --agent " + agent + " <prompt>";
  const r = await exec("opencode", args, { cwd });
  const extracted = extractOneshotText(r.stdout);
  const text = extracted.text;
  const costUsd = extracted.costUsd;
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().slice(-1200);
    return {
      code: r.code || 1,
      text: "",
      costUsd,
      stderr: "opencode run rejected argv (" + argvShape + "): " + (tail || "(empty stderr)"),
    };
  }
  if (!text) {
    const tail = (r.stderr || "").trim().slice(-800);
    return {
      code: 1,
      text: "",
      costUsd,
      stderr: "opencode run produced empty text (" + argvShape + ")" + (tail ? ": " + tail : ""),
    };
  }
  return { code: 0, text, costUsd, stderr: r.stderr };
}

/** Read-only oneshot (plan/synthesize): opencode run --agent aiwf-oneshot. */
export async function runClaudeText(
  cwd: string,
  model: string,
  system: string,
  user: string,
): Promise<ClaudeText> {
  const combined = system.trim() ? system + "\n\n---\n\n" + user : user;
  return runOpencodeOneshot(cwd, model, AGENT_ONESHOT, combined);
}

/** Reason-only oneshot (archive reconcile/dedupe): opencode run --agent aiwf-reason. */
export async function runOmpReason(
  cwd: string,
  model: string,
  prompt: string,
): Promise<ClaudeText> {
  return runOpencodeOneshot(cwd, model, AGENT_REASON, prompt);
}
