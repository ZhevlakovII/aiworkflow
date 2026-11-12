import { test } from "node:test";
import assert from "node:assert/strict";
import { destinationHitsProtected, shellTargetsProtected } from "../../tools/harness-protected.ts";

const slash = "/";
const gitRoot = "." + "git";
const ompRoot = "." + "omp";
const protectedSet = [gitRoot, ompRoot];

function protectedPattern(tokens: readonly string[]): RegExp {
  const alt = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp("(^|[\\\\/])(?:" + alt + ")([\\\\/]|$)", "i");
}

const protectedRe = protectedPattern(protectedSet);

test("destination under workflow tasks is not a protected hit when another field mentions a protected root", () => {
  const mention = gitRoot + slash + "hooks";
  const input = {
    path: ".workflow/tasks/x.md",
    content: "see " + mention,
    input: mention,
    old_string: mention,
    new_string: mention,
    command: "echo " + mention,
    code: mention,
    i: mention,
  };
  assert.equal(destinationHitsProtected(input, protectedRe), false);
});

test("destination under a protected root is a hit", () => {
  const input = { filePath: gitRoot + slash + "config", content: "ok" };
  assert.equal(destinationHitsProtected(input, protectedRe), true);
});

test("data-sink heredoc redirected at a workflow task is not a shell protected write", () => {
  const cmd =
    "cat > .workflow/tasks/x.md <<'EOF'\n" +
    "mention " +
    gitRoot +
    slash +
    "hooks\n" +
    "EOF\n";
  assert.equal(shellTargetsProtected(cmd, protectedSet), false);
});

test("redirect onto a protected root is a shell protected write", () => {
  const cmd = "echo x > " + gitRoot + slash + "config";
  assert.equal(shellTargetsProtected(cmd, protectedSet), true);
});

test("cat of a protected root is not a shell protected write", () => {
  const cmd = "cat " + gitRoot + slash + "config";
  assert.equal(shellTargetsProtected(cmd, protectedSet), false);
});
