// DSH Cordis zone-guard — tools/pre-execute → core dshGuardDecision + harness belts.
import { prodHookDeps } from "../../../../core/src/shim/command-hook.ts";
import { dshGuardDecision } from "../../../../core/src/shim/dsh-adapter.ts";
import { destinationHitsProtected, shellTargetsProtected } from "../../../../tools/harness-protected.ts";
import type { CordisContext } from "../../tools/_lib/cordis.ts";

const WRITE_TOOLS = new Set(["write", "edit", "file_write", "file_edit", "ast_edit", "notebook"]);
const PROTECTED_TOKENS = ["." + "git", "." + "dsh", "." + "dsh-aiwf"];
const PROTECTED = /(^|[\\/])\.(git|dsh|dsh-aiwf)([\\/]|$)/i;
const LEDGER = /(?:^|[\s"'=\\/])\.workflow[\\/]/i;
const BASH_WRITE_OP =
  /(?<![0-9&])>>?(?![&0-9])|\btee\b|\bcp\b|\bmv\b|\bdd\b|\bsed\s+-i|\brsync\b|\btruncate\b|\binstall\b|\bln\b|\bchmod\b|\bchown\b/i;
const GIT_MUT =
  /\bgit\s+(commit|add|push|merge|reset|checkout|restore|clean|stash|rm|apply|cherry-pick|rebase|tag)\b/i;

interface PreExecuteEvent {
  toolName: string;
  input?: Record<string, unknown>;
  isInteractive?: boolean;
}

export function registerZoneGuard(ctx: CordisContext): void {
  const cwd = ctx.cwd;
  const deps = prodHookDeps(cwd);

  ctx.hooks.on("tools/pre-execute", async (raw) => {
    const event = raw as PreExecuteEvent;
    const name = event.toolName;
    const inp = (event.input ?? {}) as Record<string, unknown>;
    const isLead = event.isInteractive === true;

    if (WRITE_TOOLS.has(name)) {
      const p = String(inp.path ?? inp.filePath ?? "");
      const coreDeny = dshGuardDecision(
        { toolName: name, input: inp, cwd, isInteractive: isLead },
        deps,
      );
      if (coreDeny) return coreDeny;
      if (destinationHitsProtected(inp, PROTECTED)) {
        return {
          block: true,
          reason: "zone-guard: запись в protected path (.git/.dsh/.dsh-aiwf) запрещена",
        };
      }
      if (isLead && p && !LEDGER.test(p)) {
        return {
          block: true,
          reason:
            "lead-guard: ты LEAD — производить нельзя. Делегируй запись воркеру. Lead пишет сам ТОЛЬКО .workflow/** (INV-5).",
        };
      }
      return;
    }

    if (name === "bash" || name === "shell" || name === "exec") {
      const cmd = String(inp.command ?? inp.code ?? inp.shell ?? "");
      const coreDeny = dshGuardDecision(
        { toolName: name, input: inp, cwd, isInteractive: isLead },
        deps,
      );
      if (coreDeny) return coreDeny;
      if (/\bgit\b[\s\S]*?\bcommit\b/i.test(cmd) && !/gated_commit/.test(cmd)) {
        return {
          block: true,
          reason:
            "commit-rail: raw `git commit` запрещён. Коммить тулом `gated_commit` (message, task?).",
        };
      }
      const gitSub = cmd.match(GIT_MUT)?.[1]?.toLowerCase();
      if (gitSub === "commit" || gitSub === "push") {
        const rail = gitSub === "commit" ? "gated_commit" : "gated_push";
        return { block: true, reason: `raw git ${gitSub} запрещён — используй ${rail}` };
      }
      if (shellTargetsProtected(cmd, PROTECTED_TOKENS)) {
        return { block: true, reason: "zone-guard: shell-запись в protected запрещена" };
      }
      if (isLead && BASH_WRITE_OP.test(cmd) && !LEDGER.test(cmd)) {
        return {
          block: true,
          reason: "lead-guard: shell-запись файлов запрещена для LEAD (INV-5).",
        };
      }
      return;
    }

    return;
  });
}
