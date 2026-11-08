// Хелперы результата custom-тула (OpenCode: execute возвращает string; ошибка = throw).
// Порт OMP _lib/result.ts. Call-sites `return ok(x)` / `return err(x)` остаются байт-идентичны:
//   ok(text) → возвращает text; err(text) → бросает (throw до return, поток не доходит до return).
export function ok(text: string, _details?: unknown): string {
  return text;
}
export function err(text: string, _details?: unknown): never {
  throw new Error(text);
}
