// fake-core fixture — relative import into a nested dir, to prove bundleCore
// preserves directory structure (relative imports keep resolving in the copy).
import { helloB } from "./sub/b.ts";

export function helloA(): string {
  return `a+${helloB()}`;
}
