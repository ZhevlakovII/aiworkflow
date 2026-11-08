// telemetry — OpenCode plugin (порт OMP hooks/omp-telemetry.ts + CC PostToolUse telemetry.py).
// Хук `tool.execute.after`: пишет kind:tool NDJSON (какой тул, успех). Best-effort, не влияет на поток.
// Guard/run-события пишут сами рельсы/воркеры через lib/telemetry (recordGuard/recordRun). Off: AIWF_TELEMETRY_OFF=1.
import type { Plugin } from "@opencode-ai/plugin";
import { recordTool } from "../lib/telemetry";

export const Telemetry: Plugin = async ({ directory }) => {
  const cwd = directory ?? process.cwd();
  return {
    "tool.execute.after": async (
      input: { tool: string },
      output: { title?: string; output?: string; metadata?: unknown; error?: unknown; isError?: boolean },
    ) => {
      if (process.env.AIWF_TELEMETRY_OFF === "1") return;
      try {
        const ok = !output?.error && !output?.isError;
        recordTool(cwd, { tool: input.tool, ok });
      } catch {
        /* fail-silent */
      }
    },
  };
};
