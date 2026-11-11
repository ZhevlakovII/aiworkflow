// aiwf_head_cli — setup.ps1/sh entry for shared head ensure (migrate + seed + OMP sync).
// Usage: node tools/aiwf_head_cli.ts ensure [--check] [--templates DIR]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureSharedHead,
  resolveAiwfHeadDir,
  resolveHomeAgentDir,
  headModelsPath,
  headConfigPath,
} from "../ports/omp/tools/_lib/aiwf_head.ts";

const args = process.argv.slice(2);
const cmd = args[0] || "ensure";
const has = (n: string) => args.includes(n);
const arg = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = arg("--templates") || path.join(here, "templates");
const modelsTpl = path.join(templates, "models.yml.example");
const headTpl = path.join(templates, "machine-head.yml.example");
const dryRun = has("--check");

if (cmd === "resolve") {
  const head = resolveAiwfHeadDir();
  console.log(JSON.stringify({
    headDir: head,
    agentDir: resolveHomeAgentDir(),
    models: headModelsPath(head),
    config: headConfigPath(head),
  }, null, 2));
  process.exit(0);
}

if (cmd !== "ensure") {
  console.error("usage: aiwf_head_cli.ts ensure|resolve [--check] [--templates DIR]");
  process.exit(2);
}

if (!dryRun) {
  if (!fs.existsSync(modelsTpl)) { console.error("missing template:", modelsTpl); process.exit(1); }
  if (!fs.existsSync(headTpl)) { console.error("missing template:", headTpl); process.exit(1); }
}

const r = ensureSharedHead({ modelsTpl, headTpl, dryRun });
console.log("--- shared-head ---");
console.log("  head:  " + r.headDir);
console.log("  agent: " + r.agentDir);
const m = r.migrate;
if (m.status === "imported") {
  console.log("  [migrate] legacy -> shared (models=" + m.models + " roles=" + m.roles + " stripped=" + m.stripped + ")");
} else if (m.status === "dry-would-import") {
  console.log("  [check] would import legacy (models=" + m.models + " roles=" + m.roles + ")");
} else if (m.status === "skipped-head-present") {
  console.log("  [keep] shared head present - no import");
} else {
  console.log("  [migrate] no legacy binding");
}
if (r.seed) {
  if (r.dryRun) {
    if (r.seed.seededModels) console.log("  [check] models.yml: ABSENT -> would seed from template");
    else console.log("  [check] models.yml: present -> keep");
    if (r.seed.seededRoles) console.log("  [check] modelRoles: ABSENT -> would seed from template");
    else console.log("  [check] modelRoles: present -> keep");
  } else {
    if (r.seed.seededModels) console.log("  [seed] models.yml <- template");
    else if (r.seed.keptModels) console.log("  [keep] models.yml present - untouched");
    if (r.seed.seededRoles) console.log("  [seed] config.yml modelRoles <- template");
    else if (r.seed.keptRoles) console.log("  [keep] modelRoles present - untouched");
  }
}
if (r.synced) {
  console.log(r.dryRun
    ? "  [check] would sync modelRoles -> home agent config.yml"
    : "  [sync] modelRoles -> home agent config.yml");
} else {
  console.log("  [sync] skip (no modelRoles in shared head yet)");
}
process.exit(0);
