// backend — per-stage worker backend resolve for DSH (fail-closed; no omp-fanout).
import * as fs from "node:fs";
import * as path from "node:path";

export type Backend = "dsh";
export type Stage = "design" | "execute";

const ALLOWED: Record<Stage, Backend[]> = {
  design: ["dsh"],
  execute: ["dsh"],
};

const RETIRED = new Set(["omp", "omp-fanout", "dsh-fanout", "claude", "codex"]);

function fromDelegationFile(cwd: string, stage: Stage): string | null {
  for (const rel of [".dsh-aiwf/delegation.yml", "delegation.yml"]) {
    const p = path.resolve(cwd, rel);
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
      const m = raw.match(new RegExp(`^\\s*${stage}\\s*:\\s*([^#\\s]+)`));
      if (m) return m[1].trim();
    }
  }
  return null;
}

export function resolveBackend(
  stage: Stage,
  taskBackend: string | null | undefined,
  cwd: string,
): { backend: Backend; source: string } {
  const envKey = `DSH_BACKEND_${stage.toUpperCase()}`;
  const fileVal = fromDelegationFile(cwd, stage);
  const raw =
    taskBackend && taskBackend.trim()
      ? { v: taskBackend, s: "task-file" }
      : process.env[envKey]
        ? { v: process.env[envKey]!, s: `env ${envKey}` }
        : fileVal
          ? { v: fileVal, s: "delegation.yml" }
          : { v: "dsh", s: "default" };
  const v = raw.v.trim().toLowerCase();
  if (RETIRED.has(v) || v.includes("fanout")) {
    throw new Error(
      `backend "${v}" unsupported on DSH (source: ${raw.s}). Fan-out: unsupported — use native lead spawn + execute_session.`,
    );
  }
  const backend = v as Backend;
  if (!ALLOWED[stage].includes(backend)) {
    throw new Error(
      `backend "${backend}" не разрешён для стадии ${stage} (источник: ${raw.s}). Допустимо: ${ALLOWED[stage].join(" | ")}.`,
    );
  }
  return { backend, source: raw.s };
}
