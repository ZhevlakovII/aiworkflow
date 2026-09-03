// OMP extension/hook — zone-guard (P2 rev4).
// Загружается явно через .omp/config.yml → extensions: (docs/extension-loading.md §4).
// Функции:
//   1. PROTECTED: write/edit/bash в .git/.omp запрещён всем.
//   2. LEAD-DELEGATION (P2): в lead-сессии (TUI, ctx.hasUI=true) write/edit/bash-write вне .workflow/**
//      блокируется → lead ВЫНУЖДЕН делегировать (INV-5). Инструкция (RULES.md) не держит — модель рационализирует
//      обход (P1/P2 probe: цитирует правило и всё равно пишет). Enforcement, не инструкция (D2).
//      Воркеры headless (hasUI=false) — не трогаем, пишут свои зоны.
//   3. FORCE-ISOLATE: каждый task-спавн → isolated:true (containment воркера).
// Оговорка: hasUI=false также у headless lead (omp -p/rpc, P4) → там lead-guard не сработает; для P4 нужен иной
//   маркер (env launcher'а). Пока (P2 интерактивно) hasUI различает lead/worker.
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { recordGuard } from "../../tools/_lib/telemetry";

const WRITE_TOOLS = new Set(["write", "edit", "ast_edit", "notebook"]);
const PROTECTED = /(^|[\\/])\.(git|omp)([\\/]|$)/i;                 // путь в .git/.omp
const PROTECTED_IN_CMD = /\.(git|omp)[\\/]/i;
// единственная lead-writable зона; матчит .workflow/ и как bare-path (^), и внутри bash-команды (после пробела/кавычки/=)
const LEDGER = /(?:^|[\s"'=\\/])\.workflow[\\/]/i;
// redirect `>`/`>>` не как fd-dup (`2>&1`), плюс write-команды
const BASH_WRITE_OP = /(?<![0-9&])>>?(?![&0-9])|\btee\b|\bcp\b|\bmv\b|\bdd\b|\bsed\s+-i|\brsync\b|\btruncate\b|\binstall\b|\bln\b|\bchmod\b|\bchown\b/i;

export default function hook(pi: HookAPI): void {
  pi.registerCommand("zonecheck", {
    description: "zone-guard status",
    handler: async () => "zone-guard rev4: protected(.git/.omp) + lead-delegation(hasUI) + force-isolate",
  });

  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;
    const inp = (event.input ?? {}) as Record<string, unknown>;
    const isLead = (ctx as { hasUI?: boolean } | undefined)?.hasUI === true;

    // 1+2. write/edit-тулы
    if (WRITE_TOOLS.has(name)) {
      const p = String(inp.path ?? "");
      const strs = [p, ...Object.values(inp)].filter((v): v is string => typeof v === "string");
      if (strs.some((v) => PROTECTED.test(v))) {
        recordGuard(process.cwd(), { event: "protected-write", tool: "zone-guard", detail: `${name} → ${p}` });
        return { block: true, reason: "zone-guard: запись в protected path (.git/.omp) запрещена" };
      }
      if (isLead && p && !LEDGER.test(p)) {
        recordGuard(process.cwd(), { event: "lead-guard", tool: "zone-guard", detail: `lead write ${name} → ${p}` });
        return { block: true, reason: "lead-guard: ты LEAD — производить нельзя. Делегируй запись через `task`-воркера. Lead пишет сам ТОЛЬКО .workflow/** (INV-5)." };
      }
      return;
    }

    // 1+2. bash/eval
    if (name === "bash" || name === "eval") {
      const cmd = String(inp.command ?? inp.code ?? "");
      // commit-rail (P3): raw `git commit` запрещён — только через tools/gated_commit.py (гейт→коммит на зелёном).
      if (/\bgit\b[\s\S]*?\bcommit\b/i.test(cmd) && !/gated_commit/.test(cmd)) {
        recordGuard(process.cwd(), { event: "raw-git-deny", tool: "zone-guard", detail: cmd.slice(0, 200) });
        return { block: true, reason: "commit-rail: raw `git commit` запрещён. Коммить нативным тулом `gated_commit` (message, task) — зона+тест гейтятся, коммит только при зелёном." };
      }
      if (PROTECTED_IN_CMD.test(cmd) && BASH_WRITE_OP.test(cmd)) {
        recordGuard(process.cwd(), { event: "protected-write", tool: "zone-guard", detail: cmd.slice(0, 200) });
        return { block: true, reason: "zone-guard: shell-запись в .git/.omp запрещена" };
      }
      if (isLead && BASH_WRITE_OP.test(cmd) && !LEDGER.test(cmd)) {
        recordGuard(process.cwd(), { event: "lead-guard", tool: "zone-guard", detail: cmd.slice(0, 200) });
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
