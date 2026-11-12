// OMP extension/hook — zone-guard (P2 rev4 + path-tool core bridge).
// Загружается явно через .omp/config.yml → extensions: (docs/extension-loading.md §4).
// Функции:
//   0. PATH-TOOL BRIDGE: write/edit/ast_edit/notebook → ompGuardDecision (SWP +
//      execute lead-freeze via prodHookDeps). Casing normalized in omp-adapter.
//   0b. BASH BRIDGE: bash/eval → ompGuardDecision(tool Bash + command) FIRST
//      (core SWP/freeze deny wins); then harness-local regex belts.
//   1. PROTECTED: write/edit/bash в .git/.omp запрещён всем (belt after core allow).
//   2. LEAD-DELEGATION (P2): в lead-сессии (TUI, ctx.hasUI=true) write/edit/bash-write вне .workflow/**
//      блокируется → lead ВЫНУЖДЕН делегировать (INV-5). Инструкция (RULES.md) не держит — модель рационализирует
//      обход (P1/P2 probe: цитирует правило и всё равно пишет). Enforcement, не инструкция (D2).
//      Воркеры headless (hasUI=false) — не трогаем, пишут свои зоны.
//   3. FORCE-ISOLATE: каждый task-спавн → isolated:true (containment воркера).
//   Bash/git regex + force-isolate remain harness-local after core (full classify rebind parked).
// Оговорка: hasUI=false также у headless lead (omp -p/rpc, P4) → там lead-guard не сработает; для P4 нужен иной
//   маркер (env launcher'а). Пока (P2 интерактивно) hasUI различает lead/worker.
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { prodHookDeps } from "../../../../core/src/shim/command-hook.ts";
import { ompGuardDecision } from "../../../../core/src/shim/omp-adapter.ts";
import { recordGuard } from "../../tools/_lib/telemetry";
import { destinationHitsProtected, shellTargetsProtected } from "../../../../tools/harness-protected.ts";

const WRITE_TOOLS = new Set(["write", "edit", "ast_edit", "notebook"]);
const PROTECTED_TOKENS = ["." + "git", "." + "omp"];
const PROTECTED = /(^|[\\/])\.(git|omp)([\\/]|$)/i;                 // путь в .git/.omp
// единственная lead-writable зона; матчит .workflow/ и как bare-path (^), и внутри bash-команды (после пробела/кавычки/=)
const LEDGER = /(?:^|[\s"'=\\/])\.workflow[\\/]/i;
// redirect `>`/`>>` не как fd-dup (`2>&1`), плюс write-команды
const BASH_WRITE_OP = /(?<![0-9&])>>?(?![&0-9])|\btee\b|\bcp\b|\bmv\b|\bdd\b|\bsed\s+-i|\brsync\b|\btruncate\b|\binstall\b|\bln\b|\bchmod\b|\bchown\b/i;

function coreGuardEvent(reason: string): string {
  if (/lead freeze/i.test(reason)) return "lead-freeze";
  if (/session_write_protected/i.test(reason)) return "session-write-protected";
  return "zone-guard-core";
}

export default function hook(pi: HookAPI): void {
  pi.registerCommand("zonecheck", {
    description: "zone-guard status",
    handler: async () =>
      "zone-guard rev4+bridge: core(SWP/lead-freeze) + protected(.git/.omp) + lead-delegation(hasUI) + force-isolate",
  });

  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;
    const inp = (event.input ?? {}) as Record<string, unknown>;
    const isLead = (ctx as { hasUI?: boolean } | undefined)?.hasUI === true;
    const cwd = process.cwd();

    // 0+1+2. write/edit-тулы — core SWP/lead-freeze first, then harness belts
    if (WRITE_TOOLS.has(name)) {
      const p = String(inp.path ?? "");
      const coreDeny = ompGuardDecision(
        { toolName: name, input: inp, cwd, hasUI: isLead },
        prodHookDeps(cwd),
      );
      if (coreDeny) {
        recordGuard(cwd, {
          event: coreGuardEvent(coreDeny.reason),
          tool: "zone-guard",
          detail: `${name} → ${p}`,
        });
        return coreDeny;
      }
      if (destinationHitsProtected(inp, PROTECTED)) {
        recordGuard(cwd, { event: "protected-write", tool: "zone-guard", detail: `${name} → ${p}` });
        return { block: true, reason: "zone-guard: запись в protected path (.git/.omp) запрещена" };
      }
      if (isLead && p && !LEDGER.test(p)) {
        recordGuard(cwd, { event: "lead-guard", tool: "zone-guard", detail: `lead write ${name} → ${p}` });
        return { block: true, reason: "lead-guard: ты LEAD — производить нельзя. Делегируй запись через `task`-воркера. Lead пишет сам ТОЛЬКО .workflow/** (INV-5)." };
      }
      return;
    }

    // 0b+1+2. bash/eval — core SWP/freeze first, then harness-local regex
    if (name === "bash" || name === "eval") {
      const cmd = String(inp.command ?? inp.code ?? "");
      const coreDeny = ompGuardDecision(
        { toolName: name, input: inp, cwd, hasUI: isLead },
        prodHookDeps(cwd),
      );
      if (coreDeny) {
        recordGuard(cwd, {
          event: coreGuardEvent(coreDeny.reason),
          tool: "zone-guard",
          detail: cmd.slice(0, 200),
        });
        return coreDeny;
      }
      // commit-rail (P3): raw `git commit` запрещён — только через tools/gated_commit.py (гейт→коммит на зелёном).
      if (/\bgit\b[\s\S]*?\bcommit\b/i.test(cmd) && !/gated_commit/.test(cmd)) {
        recordGuard(cwd, { event: "raw-git-deny", tool: "zone-guard", detail: cmd.slice(0, 200) });
        return { block: true, reason: "commit-rail: raw `git commit` запрещён. Коммить нативным тулом `gated_commit` (message, task) — зона+тест гейтятся, коммит только при зелёном." };
      }
      if (shellTargetsProtected(cmd, PROTECTED_TOKENS)) {
        recordGuard(cwd, { event: "protected-write", tool: "zone-guard", detail: cmd.slice(0, 200) });
        return { block: true, reason: "zone-guard: shell-запись в .git/.omp запрещена" };
      }
      if (isLead && BASH_WRITE_OP.test(cmd) && !LEDGER.test(cmd)) {
        recordGuard(cwd, { event: "lead-guard", tool: "zone-guard", detail: cmd.slice(0, 200) });
        return { block: true, reason: "lead-guard: ты LEAD — shell-запись файлов запрещена. Делегируй через `task`-воркера (INV-5)." };
      }
      return;
    }

    // 3. task → force isolated
    if (name === "task") {
      const patched = { ...inp } as Record<string, unknown>;
      if (Array.isArray(patched.tasks)) {
        patched.tasks = (patched.tasks as Array<Record<string, unknown>>).map((t) => ({ ...t, isolated: true }));
      } else {
        patched.isolated = true;
      }
      return { input: patched };
    }
  });
}
