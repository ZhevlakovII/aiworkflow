/**
 * Judge CLI (B1 + B2b + scaffold + roadmap) — stage machine **without model spawn**.
 *
 * Commands:
 *   design-begin --task <path>
 *   design-gate-record --task <path> --verdict PASS|BOUNCE
 *   design-critic-record --task <path> --findings <path>
 *   design-lock --task <path>
 *   design-needs-human --task <path> --reason gate|revise|critic-infra|corrupt
 *   scaffold-begin --task <path>
 *   scaffold-done --task <path> --outcome ok|violation
 *   roadmap-begin --task <path>
 *   roadmap-done --task <path> --outcome ok|violation
 *   execute-begin --task <path>
 *   execute-done --task <path> --outcome ok|violation
 *
 * Writes `.workflow/stages/<ck12>.<stage>.ndjson` events only — does not call
 * claude/omp. Exit: 0 ok, 1 blocked, 2 usage/error.
 *
 * Generation (AD-cutover-by-generation):
 *   `generation: spec-roadmap` — design-lock = spec only; roadmap-begin/done;
 *     execute-begin needs design-lock + roadmap-done ok (never fake); no scaffold-done.
 *   absent / `sp-adr` — legacy dual SP+ADR lock; scaffold lever as today.
 *
 * Pure-core + thin-shell split (same pattern as `../design/design-stage-cli.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { criticSeverity } from "../design/design-stage.ts";
import {
  criticOptInFromTaskText,
  scaffoldOptInFromTaskText,
} from "../design/critic-opt-in.ts";
import { isSpecRoadmapGeneration } from "../design/generation.ts";
import { scalarField } from "../design/task-zone.ts";
import { gateLint } from "../design/gate-lint.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import { ACTIVE_ZONE_REL, parseActiveZone } from "../rails/active-zone.ts";
import { buildPolicy, loadPolicyFile } from "../wiring/policy-source.ts";
import { artifactsFromTask } from "./attribution.ts";
import { isNeedsHumanReason, tryApplyGrant } from "./grants.ts";
import {
  appendEvent,
  artifactHash,
  readJournal,
  resolveContractKey,
  type StageJournalEvent,
} from "./journal.ts";

export const DESIGN_STAGE = "design";
export const SCAFFOLD_STAGE = "scaffold";
export const ROADMAP_STAGE = "roadmap";
export const EXECUTE_STAGE = "execute";

export const SCAFFOLD_STARTED = "scaffold-started";
export const SCAFFOLD_DONE = "scaffold-done";
export const ROADMAP_STARTED = "roadmap-started";
export const ROADMAP_DONE = "roadmap-done";
export const EXEC_STARTED = "exec-started";
export const EXEC_DONE = "exec-done";

export interface JudgeCliDeps {
  cwd: string;
  exists(p: string): boolean;
  readFile(p: string): string;
  /** Optional clock for deterministic tests. */
  now?(): string;
  /**
   * Optional resolved policy loader (grants apply). Defaults to
   * loadPolicyFile+buildPolicy over `<cwd>/policy.yml`.
   */
  loadResolvedPolicy?: () => ResolvedPolicy;
}

export interface JudgeCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const USAGE =
  "usage: judge <design-begin|design-gate-record|design-critic-record|design-lock|design-needs-human|scaffold-begin|scaffold-done|roadmap-begin|roadmap-done|execute-begin|execute-done> --task <path> [options]\n" +
  "  design-begin --task <path>\n" +
  "  design-gate-record --task <path> --verdict PASS|BOUNCE\n" +
  "  design-critic-record --task <path> --findings <path>\n" +
  "  design-lock --task <path>\n" +
  "  design-needs-human --task <path> --reason gate|revise|critic-infra|corrupt\n" +
  "  scaffold-begin --task <path>\n" +
  "  scaffold-done --task <path> --outcome ok|violation\n" +
  "  roadmap-begin --task <path>\n" +
  "  roadmap-done --task <path> --outcome ok|violation\n" +
  "  execute-begin --task <path>\n" +
  "  execute-done --task <path> --outcome ok|violation";

const COMMANDS = [
  "design-begin",
  "design-gate-record",
  "design-critic-record",
  "design-lock",
  "design-needs-human",
  "scaffold-begin",
  "scaffold-done",
  "roadmap-begin",
  "roadmap-done",
  "execute-begin",
  "execute-done",
] as const;

type JudgeCommand = (typeof COMMANDS)[number];

function isCommand(s: string): s is JudgeCommand {
  return (COMMANDS as readonly string[]).includes(s);
}

function usageError(message: string): JudgeCliOutput {
  return { stdout: USAGE, stderr: message, exitCode: 2 };
}

function ok(stdout: string): JudgeCliOutput {
  return { stdout, stderr: "", exitCode: 0 };
}

function blocked(stderr: string): JudgeCliOutput {
  return { stdout: "", stderr, exitCode: 1 };
}

function resolveTask(
  deps: JudgeCliDeps,
  taskArg: string,
): { taskPath: string; taskText: string; ck12: string } | { error: JudgeCliOutput } {
  const taskPath = path.resolve(deps.cwd, taskArg);
  if (!deps.exists(taskPath)) {
    return { error: usageError(`task file not found: ${taskPath}`) };
  }
  const taskText = deps.readFile(taskPath);
  const key = resolveContractKey(taskText, {
    repoRoot: deps.cwd,
    taskPath,
    exists: deps.exists,
    readFile: deps.readFile,
  });
  if (!key.ok) {
    return { error: blocked(key.error) };
  }
  return { taskPath, taskText, ck12: key.ck12 };
}

function taskStageOf(taskText: string): string {
  return (scalarField(taskText, "stage") || "").trim().toLowerCase();
}

function taskClassOf(taskText: string): string {
  return (scalarField(taskText, "class") || "").trim().toLowerCase();
}

/** Refuse when task stage label does not match the command family (session MISROUTE parity). */
function requireTaskStage(
  taskText: string,
  command: string,
  prefix: string,
): JudgeCliOutput | null {
  const stage = taskStageOf(taskText);
  if (!stage.startsWith(prefix)) {
    return blocked(
      `MISROUTE: ${command} requires stage:${prefix}* (got stage=${stage || "<none>"})`,
    );
  }
  return null;
}

function append(
  deps: JudgeCliDeps,
  ck12: string,
  stage: string,
  event: StageJournalEvent,
): string {
  const stamped = { ...event };
  if (deps.now && !stamped.ts) stamped.ts = deps.now();
  return appendEvent(deps.cwd, ck12, stage, stamped);
}

function lastOfType(events: StageJournalEvent[], type: string): StageJournalEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === type) return events[i];
  }
  return undefined;
}

function hasGatePass(events: StageJournalEvent[]): boolean {
  return events.some((e) => e.type === "design-gate" && e.verdict === "PASS");
}

function hasBlockingCritic(events: StageJournalEvent[]): boolean {
  const critic = lastOfType(events, "design-critic");
  if (!critic) return false;
  const blocking = critic.blocking;
  return Array.isArray(blocking) && blocking.length > 0;
}

/** Opt-in from task frontmatter OR design-begin journal flag (AD-lock-precondition-narrow-design-c). */
function isCriticOptedIn(taskText: string, events: StageJournalEvent[]): boolean {
  if (criticOptInFromTaskText(taskText)) return true;
  const begin = lastOfType(events, "design-begin");
  return begin?.critic_opt_in === true;
}

function runDesignBegin(deps: JudgeCliDeps, taskArg: string): JudgeCliOutput {
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskPath, taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "design-begin", "design");
  if (stageErr) return stageErr;
  const criticOptIn = criticOptInFromTaskText(taskText);
  append(deps, ck12, DESIGN_STAGE, {
    type: "design-begin",
    task: path.relative(deps.cwd, taskPath).split(path.sep).join("/"),
    contract_key: ck12,
    critic_opt_in: criticOptIn,
  });
  return ok(`design-begin ok ck12=${ck12}`);
}

function runDesignGateRecord(
  deps: JudgeCliDeps,
  taskArg: string,
  verdict: string,
): JudgeCliOutput {
  const v = verdict.toUpperCase();
  if (v !== "PASS" && v !== "BOUNCE") {
    return usageError(`--verdict must be PASS|BOUNCE, got: ${verdict}`);
  }
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "design-gate-record", "design");
  if (stageErr) return stageErr;
  append(deps, ck12, DESIGN_STAGE, { type: "design-gate", verdict: v });
  return ok(`design-gate-record ok verdict=${v} ck12=${ck12}`);
}

function runDesignCriticRecord(
  deps: JudgeCliDeps,
  taskArg: string,
  findingsArg: string,
): JudgeCliOutput {
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "design-critic-record", "design");
  if (stageErr) return stageErr;
  const findingsPath = path.resolve(deps.cwd, findingsArg);
  if (!deps.exists(findingsPath)) {
    return usageError(`findings file not found: ${findingsPath}`);
  }
  const { blocking, other } = criticSeverity(deps.exists, deps.readFile, findingsPath);
  append(deps, ck12, DESIGN_STAGE, {
    type: "design-critic",
    findings: path.relative(deps.cwd, findingsPath).split(path.sep).join("/"),
    blocking,
    other,
  });
  return ok(
    `design-critic-record ok blocking=${blocking.length} other=${other.length} ck12=${ck12}`,
  );
}

function runDesignNeedsHuman(
  deps: JudgeCliDeps,
  taskArg: string,
  reason: string,
): JudgeCliOutput {
  if (!isNeedsHumanReason(reason)) {
    return usageError(
      `--reason must be gate|revise|critic-infra|corrupt, got: ${reason}`,
    );
  }
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "design-needs-human", "design");
  if (stageErr) return stageErr;
  append(deps, ck12, DESIGN_STAGE, { type: "needs-human", reason });
  return ok(`design-needs-human ok reason=${reason} ck12=${ck12}`);
}

function defaultLoadResolvedPolicy(deps: JudgeCliDeps): ResolvedPolicy {
  const { policy } = loadPolicyFile(path.join(deps.cwd, "policy.yml"));
  return buildPolicy({ policy, interactive: false }).resolved;
}

/** Apply at most one matching grant when design journal has open needs-human. */
function maybeApplyGrantOnEntry(deps: JudgeCliDeps, ck12: string): void {
  const events = readJournal(deps.cwd, ck12, DESIGN_STAGE);
  const resolved =
    deps.loadResolvedPolicy?.() ?? defaultLoadResolvedPolicy(deps);
  const applied = tryApplyGrant(events, ck12, resolved.stage.grants);
  if (applied) {
    append(deps, ck12, DESIGN_STAGE, applied);
  }
}

function runDesignLock(deps: JudgeCliDeps, taskArg: string): JudgeCliOutput {
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskPath, taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "design-lock", "design");
  if (stageErr) return stageErr;
  const events = readJournal(deps.cwd, ck12, DESIGN_STAGE);

  if (!hasGatePass(events)) {
    return blocked(`design-lock blocked: no design-gate PASS in journal (ck12=${ck12})`);
  }
  if (lastOfType(events, "design-lock")) {
    return blocked(`design-lock blocked: already locked (ck12=${ck12})`);
  }

  const optedIn = isCriticOptedIn(taskText, events);
  if (optedIn) {
    const critic = lastOfType(events, "design-critic");
    if (!critic) {
      return blocked(
        `design-lock blocked: critic opted-in but no design-critic record in journal (ck12=${ck12})`,
      );
    }
    if (hasBlockingCritic(events)) {
      return blocked(`design-lock blocked: critic recorded blocking findings (ck12=${ck12})`);
    }
  } else if (hasBlockingCritic(events)) {
    // Default-off: missing critic OK; a recorded blocking critic still blocks.
    return blocked(`design-lock blocked: critic recorded blocking findings (ck12=${ck12})`);
  }

  // B3/B3.1: resolve artifacts, refuse missing, recount gateLint, hash-bind.
  const stem = path.basename(taskPath, path.extname(taskPath));
  const arts = artifactsFromTask(taskText, stem);
  const specAbs = path.join(deps.cwd, arts.spec);
  const newGen = isSpecRoadmapGeneration(taskText);

  if (newGen) {
    // spec-roadmap: product spec only — no product ADR file/covers.
    if (!deps.exists(specAbs)) {
      return blocked(`design-lock blocked: missing artifact files (spec=${arts.spec})`);
    }
    const g = gateLint(taskPath, specAbs, null, deps.cwd, { generation: "spec-roadmap" });
    if (g.findings.length > 0) {
      return blocked(
        `design-lock blocked: gate recount (${g.findings.length}): ${g.findings.join("; ")}`,
      );
    }
    const specHash = artifactHash(deps.readFile(specAbs));
    append(deps, ck12, DESIGN_STAGE, {
      type: "design-lock",
      spec: arts.spec,
      specHash,
      generation: "spec-roadmap",
    });
    return ok(`design-lock ok ck12=${ck12}`);
  }

  const adrAbs = path.join(deps.cwd, arts.adr);
  if (!deps.exists(specAbs) || !deps.exists(adrAbs)) {
    return blocked(
      `design-lock blocked: missing artifact files (spec=${arts.spec} adr=${arts.adr})`,
    );
  }
  const g = gateLint(taskPath, specAbs, adrAbs, deps.cwd);
  if (g.findings.length > 0) {
    return blocked(
      `design-lock blocked: gate recount (${g.findings.length}): ${g.findings.join("; ")}`,
    );
  }
  const specHash = artifactHash(deps.readFile(specAbs));
  const adrHash = artifactHash(deps.readFile(adrAbs));
  append(deps, ck12, DESIGN_STAGE, {
    type: "design-lock",
    spec: arts.spec,
    adr: arts.adr,
    specHash,
    adrHash,
  });
  return ok(`design-lock ok ck12=${ck12}`);
}

function hasDesignLock(deps: JudgeCliDeps, ck12: string): boolean {
  return readJournal(deps.cwd, ck12, DESIGN_STAGE).some((e) => e.type === "design-lock");
}

function hasScaffoldDoneOk(deps: JudgeCliDeps, ck12: string): boolean {
  return readJournal(deps.cwd, ck12, SCAFFOLD_STAGE).some(
    (e) => e.type === SCAFFOLD_DONE && e.outcome === "ok",
  );
}

function hasRoadmapDoneOk(deps: JudgeCliDeps, ck12: string): boolean {
  return readJournal(deps.cwd, ck12, ROADMAP_STAGE).some(
    (e) => e.type === ROADMAP_DONE && e.outcome === "ok",
  );
}

/**
 * Contract B — `by:judge` mutual exclusion on scaffold/roadmap/execute begin.
 * Missing file OK. Parsed zone with `by === "judge"` OK. Legacy lead zone
 * (file exists, parses, `by !== "judge"`) → exit 1. Unreadable/invalid
 * parse does not apply this gate (L1 load unchanged; begin continues).
 */
function checkJudgeZoneExclusive(
  deps: JudgeCliDeps,
  command: "scaffold-begin" | "roadmap-begin" | "execute-begin",
): JudgeCliOutput | null {
  const zonePath = path.join(deps.cwd, ACTIVE_ZONE_REL);
  if (!deps.exists(zonePath)) return null;
  let text: string;
  try {
    text = deps.readFile(zonePath);
  } catch {
    return null;
  }
  const load = parseActiveZone(text);
  if (load.kind !== "zone") return null;
  if (load.by === "judge") return null;
  return blocked(
    `${command} blocked: legacy lead zone active (.workflow/active-zone.json by≠judge); clear zone or set by:judge`,
  );
}

function runScaffoldBegin(deps: JudgeCliDeps, taskArg: string): JudgeCliOutput {
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskPath, taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "scaffold-begin", "scaffold");
  if (stageErr) return stageErr;
  // New generation: scaffold is retired — refuse, no fake journal.
  if (isSpecRoadmapGeneration(taskText)) {
    return blocked(
      "scaffold-begin blocked: generation=spec-roadmap (scaffold retired; use roadmap-begin)",
    );
  }
  // Lever off → refuse and write nothing (no fake journal).
  if (!scaffoldOptInFromTaskText(taskText)) {
    return blocked(
      "scaffold-begin blocked: scaffold lever is off (set scaffold: on|true|1|yes on session task)",
    );
  }
  const zoneBlock = checkJudgeZoneExclusive(deps, "scaffold-begin");
  if (zoneBlock) return zoneBlock;
  if (!hasDesignLock(deps, ck12)) {
    return blocked(`scaffold-begin blocked: no design-lock in design journal (ck12=${ck12})`);
  }
  append(deps, ck12, SCAFFOLD_STAGE, {
    type: SCAFFOLD_STARTED,
    task: path.relative(deps.cwd, taskPath).split(path.sep).join("/"),
    contract_key: ck12,
  });
  return ok(`scaffold-begin ok ck12=${ck12}`);
}

function runScaffoldDone(
  deps: JudgeCliDeps,
  taskArg: string,
  outcome: string,
): JudgeCliOutput {
  const o = outcome.toLowerCase();
  if (o !== "ok" && o !== "violation") {
    return usageError(`--outcome must be ok|violation, got: ${outcome}`);
  }
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "scaffold-done", "scaffold");
  if (stageErr) return stageErr;
  const events = readJournal(deps.cwd, ck12, SCAFFOLD_STAGE);
  if (!events.some((e) => e.type === SCAFFOLD_STARTED)) {
    return blocked(`scaffold-done blocked: no scaffold-started in journal (ck12=${ck12})`);
  }
  append(deps, ck12, SCAFFOLD_STAGE, { type: SCAFFOLD_DONE, outcome: o });
  return ok(`scaffold-done ok outcome=${o} ck12=${ck12}`);
}

function runRoadmapBegin(deps: JudgeCliDeps, taskArg: string): JudgeCliOutput {
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskPath, taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "roadmap-begin", "roadmap");
  if (stageErr) return stageErr;
  // Fail-closed: only for spec-roadmap generation (legacy → refuse).
  if (!isSpecRoadmapGeneration(taskText)) {
    return blocked(
      "roadmap-begin blocked: generation must be spec-roadmap (legacy sp-adr has no roadmap stage)",
    );
  }
  const zoneBlock = checkJudgeZoneExclusive(deps, "roadmap-begin");
  if (zoneBlock) return zoneBlock;
  if (!hasDesignLock(deps, ck12)) {
    return blocked(`roadmap-begin blocked: no design-lock in design journal (ck12=${ck12})`);
  }
  append(deps, ck12, ROADMAP_STAGE, {
    type: ROADMAP_STARTED,
    task: path.relative(deps.cwd, taskPath).split(path.sep).join("/"),
    contract_key: ck12,
  });
  return ok(`roadmap-begin ok ck12=${ck12}`);
}

function runRoadmapDone(
  deps: JudgeCliDeps,
  taskArg: string,
  outcome: string,
): JudgeCliOutput {
  const o = outcome.toLowerCase();
  if (o !== "ok" && o !== "violation") {
    return usageError(`--outcome must be ok|violation, got: ${outcome}`);
  }
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "roadmap-done", "roadmap");
  if (stageErr) return stageErr;
  if (!isSpecRoadmapGeneration(taskText)) {
    return blocked(
      "roadmap-done blocked: generation must be spec-roadmap (legacy sp-adr has no roadmap stage)",
    );
  }
  const events = readJournal(deps.cwd, ck12, ROADMAP_STAGE);
  if (!events.some((e) => e.type === ROADMAP_STARTED)) {
    return blocked(`roadmap-done blocked: no roadmap-started in journal (ck12=${ck12})`);
  }
  append(deps, ck12, ROADMAP_STAGE, { type: ROADMAP_DONE, outcome: o });
  return ok(`roadmap-done ok outcome=${o} ck12=${ck12}`);
}

function runExecuteBegin(deps: JudgeCliDeps, taskArg: string): JudgeCliOutput {
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskPath, taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "execute-begin", "execute");
  if (stageErr) return stageErr;
  const zoneBlock = checkJudgeZoneExclusive(deps, "execute-begin");
  if (zoneBlock) return zoneBlock;

  const newGen = isSpecRoadmapGeneration(taskText);
  if (newGen) {
    // spec-roadmap: design-lock + roadmap-done ok; never require/fake scaffold-done.
    if (!hasDesignLock(deps, ck12)) {
      return blocked(`execute-begin blocked: no design-lock in design journal (ck12=${ck12})`);
    }
    if (!hasRoadmapDoneOk(deps, ck12)) {
      return blocked(
        `execute-begin blocked: no roadmap-done outcome=ok in roadmap journal (ck12=${ck12})`,
      );
    }
  } else {
    const scaffoldOn = scaffoldOptInFromTaskText(taskText);
    const cls = taskClassOf(taskText);
    const trivial = cls === "trivial";
    // Design-lock required unless class trivial AND scaffold lever off.
    // Scaffold on never skips design-lock (even for trivial).
    const needDesignLock = scaffoldOn || !trivial;
    if (needDesignLock && !hasDesignLock(deps, ck12)) {
      return blocked(`execute-begin blocked: no design-lock in design journal (ck12=${ck12})`);
    }
    // Scaffold-done only when lever on; never fabricate when off.
    if (scaffoldOn && !hasScaffoldDoneOk(deps, ck12)) {
      return blocked(
        `execute-begin blocked: no scaffold-done outcome=ok in scaffold journal (ck12=${ck12})`,
      );
    }
  }

  append(deps, ck12, EXECUTE_STAGE, {
    type: EXEC_STARTED,
    task: path.relative(deps.cwd, taskPath).split(path.sep).join("/"),
    contract_key: ck12,
  });
  return ok(`execute-begin ok ck12=${ck12}`);
}

function runExecuteDone(
  deps: JudgeCliDeps,
  taskArg: string,
  outcome: string,
): JudgeCliOutput {
  const o = outcome.toLowerCase();
  if (o !== "ok" && o !== "violation") {
    return usageError(`--outcome must be ok|violation, got: ${outcome}`);
  }
  const resolved = resolveTask(deps, taskArg);
  if ("error" in resolved) return resolved.error;
  const { taskText, ck12 } = resolved;
  const stageErr = requireTaskStage(taskText, "execute-done", "execute");
  if (stageErr) return stageErr;
  const events = readJournal(deps.cwd, ck12, EXECUTE_STAGE);
  if (!events.some((e) => e.type === EXEC_STARTED)) {
    return blocked(`execute-done blocked: no exec-started in journal (ck12=${ck12})`);
  }
  append(deps, ck12, EXECUTE_STAGE, { type: EXEC_DONE, outcome: o });
  return ok(`execute-done ok outcome=${o} ck12=${ck12}`);
}

interface ParsedJudgeArgs {
  command?: string;
  task?: string;
  verdict?: string;
  findings?: string;
  outcome?: string;
  reason?: string;
  help: boolean;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedJudgeArgs; error?: string } {
  if (argv.length === 0) return { parsed: { help: true } };

  let command: string | undefined;
  let task: string | undefined;
  let verdict: string | undefined;
  let findings: string | undefined;
  let outcome: string | undefined;
  let reason: string | undefined;
  let help = false;
  let i = 0;

  const first = argv[0];
  if (first === "--help" || first === "-h") {
    return { parsed: { help: true } };
  }
  if (isCommand(first)) {
    command = first;
    i = 1;
  } else {
    return { error: `unknown command: ${first}` };
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--task") {
      const v = argv[++i];
      if (v === undefined) return { error: "--task: требуется значение" };
      task = v;
    } else if (a === "--verdict") {
      const v = argv[++i];
      if (v === undefined) return { error: "--verdict: требуется значение" };
      verdict = v;
    } else if (a === "--findings") {
      const v = argv[++i];
      if (v === undefined) return { error: "--findings: требуется значение" };
      findings = v;
    } else if (a === "--outcome") {
      const v = argv[++i];
      if (v === undefined) return { error: "--outcome: требуется значение" };
      outcome = v;
    } else if (a === "--reason") {
      const v = argv[++i];
      if (v === undefined) return { error: "--reason: требуется значение" };
      reason = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }

  return { parsed: { command, task, verdict, findings, outcome, reason, help } };
}

/** Injectable, testable judge CLI entry. */
export function runJudgeCli(argv: readonly string[], deps: JudgeCliDeps): JudgeCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return usageError(error ?? "usage error");
  }
  if (parsed.help || !parsed.command) {
    return { stdout: USAGE, stderr: "", exitCode: 2 };
  }
  if (!parsed.task) {
    return usageError("--task: обязателен");
  }

  // Grant apply on entry when needs-human is open (before command body).
  const resolved = resolveTask(deps, parsed.task);
  if (!("error" in resolved)) {
    maybeApplyGrantOnEntry(deps, resolved.ck12);
  }

  switch (parsed.command) {
    case "design-begin":
      return runDesignBegin(deps, parsed.task);
    case "design-gate-record":
      if (!parsed.verdict) return usageError("--verdict: обязателен");
      return runDesignGateRecord(deps, parsed.task, parsed.verdict);
    case "design-critic-record":
      if (!parsed.findings) return usageError("--findings: обязателен");
      return runDesignCriticRecord(deps, parsed.task, parsed.findings);
    case "design-lock":
      return runDesignLock(deps, parsed.task);
    case "design-needs-human":
      if (!parsed.reason) return usageError("--reason: обязателен");
      return runDesignNeedsHuman(deps, parsed.task, parsed.reason);
    case "scaffold-begin":
      return runScaffoldBegin(deps, parsed.task);
    case "scaffold-done":
      if (!parsed.outcome) return usageError("--outcome: обязателен");
      return runScaffoldDone(deps, parsed.task, parsed.outcome);
    case "roadmap-begin":
      return runRoadmapBegin(deps, parsed.task);
    case "roadmap-done":
      if (!parsed.outcome) return usageError("--outcome: обязателен");
      return runRoadmapDone(deps, parsed.task, parsed.outcome);
    case "execute-begin":
      return runExecuteBegin(deps, parsed.task);
    case "execute-done":
      if (!parsed.outcome) return usageError("--outcome: обязателен");
      return runExecuteDone(deps, parsed.task, parsed.outcome);
    default:
      return usageError(`unknown command: ${parsed.command}`);
  }
}

function prodDeps(): JudgeCliDeps {
  return {
    cwd: process.cwd(),
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runJudgeCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + (stdout.endsWith("\n") ? "" : "\n"));
  if (stderr) process.stderr.write(stderr + (stderr.endsWith("\n") ? "" : "\n"));
  process.exit(exitCode);
}

if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    main();
  }
}
