/**
 * Harness protected-path belt shared by OMP / DSH / OpenCode zone-guards.
 * Destination keys only — never scan content, input, old_string, new_string,
 * command, code, or i. No @oh-my-pi import.
 */
import { isWriteToProtected, maskHeredocs } from "../core/src/classify/zone.ts";

export const DESTINATION_KEYS = [
  "path",
  "filePath",
  "file_path",
  "notebookPath",
  "notebook_path",
] as const;

export function destinationStrings(
  input: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
  if (input == null || typeof input !== "object") return [];
  const out: string[] = [];
  for (const key of DESTINATION_KEYS) {
    const value = input[key];
    if (typeof value === "string") out.push(value);
  }
  return out;
}

/** True when a destination field matches `protectedPattern`. Other fields are ignored. */
export function destinationHitsProtected(
  input: Readonly<Record<string, unknown>> | null | undefined,
  protectedPattern: RegExp,
): boolean {
  for (const value of destinationStrings(input)) {
    protectedPattern.lastIndex = 0;
    if (protectedPattern.test(value)) return true;
  }
  return false;
}

/** Posix write-to-protected check after data-sink heredoc bodies are masked. */
export function shellTargetsProtected(cmd: string, protectedSet: readonly string[]): boolean {
  return isWriteToProtected(maskHeredocs(cmd), "posix", protectedSet);
}
