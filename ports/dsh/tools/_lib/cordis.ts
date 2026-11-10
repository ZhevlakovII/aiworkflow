// Minimal Cordis plugin shapes — real types from peer `@deepseek-ai/cordis` at consumer install.
import { ok, err } from "./result";

export interface CordisToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<string | { error: true; message: string }>;
}

export interface CordisContext {
  cwd: string;
  tools: {
    register: (tool: CordisToolSpec) => void;
    defineTool?: (spec: CordisToolSpec) => CordisToolSpec;
  };
  hooks: {
    on: (event: string, handler: (payload: unknown) => Promise<unknown>) => void;
  };
  /** Optional Cordis host: nested harness exec (one-shot plan/synthesize). */
  exec?: (
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Optional: autonomous queue inject at turn end (persistent dsh session). */
  sendMessage?: (text: string, opts?: { triggerTurn?: boolean; deliverAs?: string }) => void;
  logger?: { info?: (m: string) => void; error?: (m: string) => void };
  registerCommand?: (name: string, spec: { description: string; handler: () => Promise<string> }) => void;
}

export type DshToolContext = CordisContext;

export function emitToolResult(
  r: ReturnType<typeof ok> | ReturnType<typeof err>,
): string | { error: true; message: string } {
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) return { error: true, message: text };
  return text;
}
