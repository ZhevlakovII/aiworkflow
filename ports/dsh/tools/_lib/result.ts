// Хелперы результата custom-тула (AgentToolResult shape).
export function ok(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
export function err(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details, isError: true };
}
