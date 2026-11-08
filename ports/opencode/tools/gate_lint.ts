// gate_lint — standalone обёртка над детерминированным two-stage design-гейтом (lib/gatelint).
// Механический запуск линтера (не свободное суждение): SP source-ref + SP↔AD coverage + EARS-синтакс FR.
// В design-пути гейт исполняется ВНУТРИ design_session(step=gate); этот тул — ручной re-lint (паритет с CC /aiwf-gate).
import { tool } from "@opencode-ai/plugin";
import * as path from "node:path";
import { gateLint } from "../lib/gatelint";
import { ok, err } from "../lib/result";

export default tool({
  description:
    "Детерминированный design-гейт (gateLint): SP source-ref (анти-фабрикация) + SP↔AD coverage + " +
    "EARS-синтакс FR. findings=[] → PASS; иначе BOUNCE (вернуть producer'у с findings). НЕ объявляй PASS при findings.",
  args: {
    task: tool.schema.string().describe("task-file (источник контракта)"),
    spec: tool.schema.string().describe("spec-файл"),
    adr: tool.schema.string().describe("ADR-файл"),
  },
  async execute(params, ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    const g = gateLint(
      path.resolve(cwd, params.task),
      path.resolve(cwd, params.spec),
      path.resolve(cwd, params.adr),
      cwd,
    );
    const summary = `SP:${g.nSp} AD:${g.nAd} FR:${g.nFr} findings:${g.findings.length}`;
    if (g.findings.length) return err(`GATE BOUNCE\n${summary}\n` + g.findings.map((f) => "  [x] " + f).join("\n"));
    return ok(`GATE PASS\n${summary}`);
  },
});
