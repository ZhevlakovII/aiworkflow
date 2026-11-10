// astindex — ast-index CLI wrapper for DSH discovery tools (P1 parity with OMP).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CAP = 8000;

export interface ExecPi {
  exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Default exec via child_process (Cordis may inject a richer ExecPi at runtime). */
export const nodeExecPi: ExecPi = {
  async exec(cmd, args, { cwd }) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      });
      return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (e: unknown) {
      const err = e as { code?: number | string; stdout?: string; stderr?: string };
      const code = typeof err.code === "number" ? err.code : 1;
      return {
        code,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? (e instanceof Error ? e.message : String(e)),
      };
    }
  },
};

export async function ensureIndex(pi: ExecPi, cwd: string): Promise<void> {
  const st = await pi.exec("ast-index", ["stats"], { cwd });
  if (st.code !== 0) {
    await pi.exec("ast-index", ["rebuild"], { cwd });
    return;
  }
  await pi.exec("ast-index", ["update"], { cwd });
}

export async function runAst(
  pi: ExecPi,
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  await ensureIndex(pi, cwd);
  const r = await pi.exec("ast-index", args, { cwd });
  if (r.code !== 0) {
    return {
      ok: false,
      text: `ast-index ${args.join(" ")} rc=${r.code}\n${(r.stderr || r.stdout || "").slice(-1200)}`,
    };
  }
  let out = (r.stdout || "").trim() || "(пусто — ничего не найдено)";
  if (out.length > CAP) out = out.slice(0, CAP) + "\n…(усечено; уточни запрос)";
  return { ok: true, text: out };
}
