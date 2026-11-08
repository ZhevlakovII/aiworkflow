// fake-core fixture — third file, sibling-level relative import.
import { helloA } from "./a.ts";

export function helloC(): string {
  return `c+${helloA()}`;
}
