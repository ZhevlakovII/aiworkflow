// exec-shim — замена OMP `pi.exec(cmd, args, {cwd})` на Bun `$`.
// КЛЮЧЕВОЙ seam: рельсы зовут git/gh/claude через ЭТОТ shim (Bun `$`), а НЕ через bash-тул →
//   zone-guard plugin (tool.execute.before на "bash") их не перехватывает, как pi.exec в OMP.
// Возврат нормализован в OMP-shape {code, stdout, stderr} → тела портированных тулов не меняются.
import { $ } from "bun";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function exec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult> {
  const r = await $`${cmd} ${args}`.cwd(opts?.cwd ?? process.cwd()).quiet().nothrow();
  return {
    code: typeof r.exitCode === "number" ? r.exitCode : 0,
    stdout: r.stdout?.toString?.() ?? "",
    stderr: r.stderr?.toString?.() ?? "",
  };
}

/** sh -c <script> (для test-cmd / gate-команд). */
export async function sh(script: string, opts?: { cwd?: string }): Promise<ExecResult> {
  const r = await $`sh -c ${script}`.cwd(opts?.cwd ?? process.cwd()).quiet().nothrow();
  return {
    code: typeof r.exitCode === "number" ? r.exitCode : 0,
    stdout: r.stdout?.toString?.() ?? "",
    stderr: r.stderr?.toString?.() ?? "",
  };
}
