// design_session — in-session design driver (B2a). Thin Cordis tool over judge + gateLint.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DshToolContext } from "./_lib/cordis.ts";
import { emitToolResult } from "./_lib/cordis.ts";
import { parseZone, scalarField } from "./_lib/task";
import { gateLint } from "./_lib/gatelint";
import { ok, err } from "./_lib/result";
import { runJudgeCli, type JudgeCliDeps } from "../../../core/src/stage/judge-cli.ts";
import {
  contractKey12,
  readJournal,
  type StageJournalEvent,
} from "../../../core/src/stage/journal.ts";

const STEPS = ["begin", "gate", "critic-record", "lock"] as const;
type Step = (typeof STEPS)[number];

export function outDirFromTask(taskText: string): string {
  const a = parseZone(taskText).allow.find((x) => !x.startsWith(".workflow"));
  return (a || "docs/design").replace(/\/\*\*?$/, "").trim() || "docs/design";
}

export function designArtifactRels(taskText: string, tid: string) {
  const out = outDirFromTask(taskText);
  return {
    out,
    specRel: `${out}/${tid}-spec.md`,
    adrRel: `${out}/${tid}-adr.md`,
    findingsRel: `.workflow/ledger/${tid}-findings.md`,
  };
}

function prodDeps(cwd: string): JudgeCliDeps {
  return { cwd, exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf-8") };
}

function judgeToTool(r: { stdout: string; stderr: string; exitCode: number }, extra = "") {
  const body = [r.stdout, r.stderr, extra].filter((s) => s && s.trim()).join("\n");
  if (r.exitCode === 0) return ok(body || "ok");
  return err(body || `judge exit ${r.exitCode}`);
}

function countGateBounces(events: StageJournalEvent[]): number {
  return events.filter((e) => e.type === "design-gate" && e.verdict === "BOUNCE").length;
}

function hasCriticRecord(events: StageJournalEvent[]): boolean {
  return events.some((e) => e.type === "design-critic");
}

export function registerDesignSession(ctx: DshToolContext): void {
  const register = ctx.tools.defineTool?.bind(ctx.tools) ?? ctx.tools.register.bind(ctx.tools);
  register({
    name: "design_session",
    description:
      "Design driver: begin | gate | critic-record | lock. Judge + gateLint only — lead spawns producer/critic.",
    parameters: {
      type: "object",
      properties: {
        step: { type: "string", enum: [...STEPS] },
        task: { type: "string" },
        findings: { type: "string" },
      },
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
      if (!stage.startsWith("design")) {
        return emitToolResult(
          err(`MISROUTE: design_session на не-design задаче (stage=${stage || "<none>"}). Только stage:design*.`),
        );
      }
      const taskRel = path.relative(cwd, taskPath).split(path.sep).join("/");
      const deps = prodDeps(cwd);
      const arts = designArtifactRels(taskText, tid);
      const ck12 = contractKey12(taskText);

      if (step === "begin") {
        const r = runJudgeCli(["design-begin", "--task", taskRel], deps);
        if (r.exitCode !== 0) return emitToolResult(judgeToTool(r));
        const handoff =
          `=== DESIGN SESSION begin: ${tid} (ck12=${ck12}) ===\n${r.stdout}\n\n` +
          `Producer handoff:\n  task: ${taskRel}\n  spec → ${arts.specRel}\n  ADR → ${arts.adrRel}\n` +
          `Next: design_session(step=gate, task=...).`;
        return emitToolResult(ok(handoff));
      }

      if (step === "gate") {
        const specPath = path.resolve(cwd, arts.specRel);
        const adrPath = path.resolve(cwd, arts.adrRel);
        if (!fs.existsSync(specPath) || !fs.existsSync(adrPath)) {
          return emitToolResult(err(`gate: нет артефактов (${arts.specRel}, ${arts.adrRel}).`));
        }
        const priorBounces = countGateBounces(readJournal(cwd, ck12, "design"));
        const g = gateLint(taskPath, specPath, adrPath, cwd);
        const verdict = g.findings.length ? "BOUNCE" : "PASS";
        const summary =
          `SP:${g.nSp} AD:${g.nAd} FR:${g.nFr} findings:${g.findings.length}\n` +
          g.findings.map((f) => "  [x] " + f).join("\n");
        const r = runJudgeCli(["design-gate-record", "--task", taskRel, "--verdict", verdict], deps);
        if (r.exitCode !== 0) return emitToolResult(judgeToTool(r, summary));
        if (verdict === "PASS") {
          return emitToolResult(ok(`${r.stdout}\ngateLint PASS\n${summary}\nNext: critic-record.`));
        }
        if (priorBounces >= 1) {
          return emitToolResult(err(`${r.stdout}\ngateLint BOUNCE — budget exhausted.\n${summary}`));
        }
        return emitToolResult(ok(`${r.stdout}\ngateLint BOUNCE (retry 1).\n${summary}`));
      }

      if (step === "critic-record") {
        const findingsRel = (params.findings as string) || arts.findingsRel;
        const findingsPath = path.resolve(cwd, findingsRel);
        if (!fs.existsSync(findingsPath)) return emitToolResult(err(`critic-record: findings не найдены: ${findingsRel}`));
        if (hasCriticRecord(readJournal(cwd, ck12, "design"))) {
          return emitToolResult(err("critic-record budget=1 already used."));
        }
        const findingsArg = path.relative(cwd, findingsPath).split(path.sep).join("/");
        const r = runJudgeCli(["design-critic-record", "--task", taskRel, "--findings", findingsArg], deps);
        if (r.exitCode !== 0) return emitToolResult(judgeToTool(r));
        return emitToolResult(ok(`${r.stdout}\nNext: design_session(step=lock, task=...).`));
      }

      if (step === "lock") {
        const r = runJudgeCli(["design-lock", "--task", taskRel], deps);
        if (r.exitCode !== 0) return emitToolResult(judgeToTool(r));
        return emitToolResult(
          ok(`${r.stdout}\nDESIGN LOCKED. Commit via gated_commit(message=..., task=${taskRel}).`),
        );
      }

      return emitToolResult(err(`unknown step: ${step}`));
    },
  });
}
