// execute_session — in-session execute driver (B2b).
import * as fs from "node:fs";
import * as path from "node:path";
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { parseZone, scalarField } from "./_lib/task";
import { zoneCheck } from "./_lib/zonecheck";
import { resolveAgent, loadZoneMap, type ZoneMap } from "./_lib/zonemap";
import { ok, err } from "./_lib/result";
import { nodeGitSeam } from "../../../core/src/rails/git-seam.ts";
import { runJudgeCli, type JudgeCliDeps } from "../../../core/src/stage/judge-cli.ts";
import { contractKey12 } from "../../../core/src/stage/journal.ts";

const STEPS = ["begin", "check", "done"] as const;
type Step = (typeof STEPS)[number];
const ACTIVE_ZONE_REL = ".workflow/active-zone.json";
const ZONEMAP_REL = ".dsh-aiwf/zonemap.yml";

function resolveExecuteDomain(cwd: string, taskText: string) {
  let zm: ZoneMap | null = null;
  try {
    zm = loadZoneMap(path.resolve(cwd, ZONEMAP_REL));
  } catch {
    zm = null;
  }
  if (!zm) return { agent: "executor", note: "нет zonemap → generic executor" };
  const { allow } = parseZone(taskText);
  const r = resolveAgent(allow, zm);
  if (r.denied.length) return { agent: "executor", note: `deny-domain (${r.denied.join(",")})` };
  if (r.ambiguous) {
    return { agent: "executor", note: `ambiguous (${r.matched.join(",")}) → executor` };
  }
  return {
    agent: r.agent,
    note: r.agent === "executor" ? "нет домен-матча" : `домен ${r.tech} → ${r.agent}`,
  };
}

function writeActiveZone(cwd: string, tid: string, allow: string[], deny: string[]): string {
  const abs = path.join(cwd, ACTIVE_ZONE_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body: { task: string; allow: string[]; deny?: string[]; by: "judge" } = {
    task: tid,
    allow,
    by: "judge",
  };
  if (deny.length) body.deny = deny;
  fs.writeFileSync(abs, JSON.stringify(body), "utf8");
  return ACTIVE_ZONE_REL;
}

function evalStagedZone(cwd: string, taskText: string) {
  const git = nodeGitSeam(cwd);
  const add = git.run(["git", "add", "-A"]);
  if (add.code !== 0) return { staged: [] as string[], violations: [] as string[], error: "git add failed" };
  const diff = git.run(["git", "diff", "--cached", "--name-only"]);
  if (diff.code !== 0) return { staged: [], violations: [], error: "git diff --cached failed" };
  const staged = diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const z = parseZone(taskText);
  const violations = z.allow.length ? zoneCheck(staged, z.allow, z.deny) : [];
  return { staged, violations, error: undefined as string | undefined };
}

function prodDeps(cwd: string): JudgeCliDeps {
  return { cwd, exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf-8") };
}

function judgeToTool(r: { stdout: string; stderr: string; exitCode: number }, extra = "") {
  const body = [r.stdout, r.stderr, extra].filter((s) => s && s.trim()).join("\n");
  if (r.exitCode === 0) return ok(body || "ok");
  return err(body || `judge exit ${r.exitCode}`);
}

function formatCheck(ev: ReturnType<typeof evalStagedZone>): string {
  const files = ev.staged.length ? ev.staged.map((s) => "  + " + s).join("\n") : "  (none staged)";
  if (ev.violations.length) {
    return (
      `zoneCheck VIOLATION (${ev.violations.length}):\n` +
      ev.violations.map((x) => "  [x] " + x).join("\n") +
      `\nstaged:\n${files}`
    );
  }
  return `zoneCheck OK (${ev.staged.length} staged)\nstaged:\n${files}`;
}

export function registerExecuteSession(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "execute_session",
    description: "Execute driver: begin | check | done. Judge + zoneCheck; lead spawns executor/domain-dev.",
    parameters: {
      type: "object",
      properties: { step: { type: "string", enum: [...STEPS] }, task: { type: "string" } },
      required: ["step", "task"],
    },
    async execute(params) {
      const cwd = ctx.cwd;
      const step = params.step as Step;
      const taskPath = path.resolve(cwd, String(params.task));
      if (!fs.existsSync(taskPath)) return emitToolResult(err("task-file не найден: " + params.task));
      const taskText = fs.readFileSync(taskPath, "utf8");
      const tid = scalarField(taskText, "id") || path.basename(taskPath, ".md");
      const stage = (scalarField(taskText, "stage") || "").toLowerCase();
      if (stage.startsWith("design")) {
        return emitToolResult(err(`MISROUTE: execute_session на design-задаче (stage=${stage}).`));
      }
      const taskRel = path.relative(cwd, taskPath).split(path.sep).join("/");
      const deps = prodDeps(cwd);
      const z = parseZone(taskText);
      const ck12 = contractKey12(taskText);

      if (step === "begin") {
        const r = runJudgeCli(["execute-begin", "--task", taskRel], deps);
        if (r.exitCode !== 0) return emitToolResult(judgeToTool(r));
        const { agent, note } = resolveExecuteDomain(cwd, taskText);
        const zoneRel = writeActiveZone(cwd, tid, z.allow, z.deny);
        const globs = z.allow.length ? z.allow.map((g) => "  - " + g).join("\n") : "  (none)";
        const handoff =
          `=== EXECUTE begin: ${tid} (ck12=${ck12}) ===\n${r.stdout}\n\n` +
          `Spawn ${agent} [${note}]:\n  task: ${taskRel}\n  zone: ${zoneRel}\n  allow:\n${globs}`;
        return emitToolResult(ok(handoff));
      }

      if (step === "check") {
        const ev = evalStagedZone(cwd, taskText);
        if (ev.error) return emitToolResult(err(ev.error));
        const summary = formatCheck(ev);
        if (ev.violations.length) return emitToolResult(err(summary));
        return emitToolResult(ok(`${summary}\nNext: execute_session(step=done, task=...).`));
      }

      if (step === "done") {
        const ev = evalStagedZone(cwd, taskText);
        if (ev.error) return emitToolResult(err(ev.error));
        const outcome = ev.violations.length ? "violation" : "ok";
        const r = runJudgeCli(["execute-done", "--task", taskRel, "--outcome", outcome], deps);
        const summary = formatCheck(ev);
        if (r.exitCode !== 0) return emitToolResult(judgeToTool(r, summary));
        if (outcome === "violation") return emitToolResult(err(`${r.stdout}\n${summary}`));
        return emitToolResult(
          ok(`${r.stdout}\n${summary}\nEXECUTE DONE. gated_commit(message=..., task=${taskRel}).`),
        );
      }

      return emitToolResult(err(`unknown step: ${step}`));
    },
  });
}
