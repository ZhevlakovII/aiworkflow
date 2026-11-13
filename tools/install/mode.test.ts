import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, ModeError } from "./mode.ts";

describe("resolveMode", () => {
  it("maps -y and --yes to yolo", () => {
    assert.equal(resolveMode(["-y"], true), "yolo");
    assert.equal(resolveMode(["--yes"], false), "yolo");
    assert.equal(resolveMode(["--mode", "yolo"], true), "yolo");
  });

  it("defaults full on TTY and yolo off TTY", () => {
    assert.equal(resolveMode([], true), "full");
    assert.equal(resolveMode([], false), "yolo");
  });

  it("rejects conflicting flags", () => {
    assert.throws(() => resolveMode(["--soft", "-y"], true), ModeError);
  });
});
