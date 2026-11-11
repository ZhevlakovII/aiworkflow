// aiwf_head smoke: resolve chain + migrate once + no-overwrite + strip.
// Run: node --experimental-strip-types ports/omp/tools/_lib/aiwf_head.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveAiwfHeadDir, resolveHomeAgentDir, migrateLegacyOnce, seedSharedHeadIfAbsent,
  ensureSharedHead, hasHeadBinding, syncModelRolesToOmp, headModelsPath, headConfigPath,
  legacyModelsPath, legacyConfigPath, configHasModelRolesKey,
} from "./aiwf_head.ts";
import { parseModelRoles } from "./modelroles.ts";

const n = String.fromCharCode(10);
let fails = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + "  got=" + JSON.stringify(got)); fails++; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwf-head-"));
const home = path.join(tmpRoot, "home");
fs.mkdirSync(home);
const envBase: Record<string, string> = { HOME: home, USERPROFILE: home, AIWF_CONFIG_HOME: "", XDG_CONFIG_HOME: "" };

check("default config/aiwf", resolveAiwfHeadDir(envBase) === path.join(home, ".config", "aiwf"));
check("XDG wins", resolveAiwfHeadDir({ ...envBase, XDG_CONFIG_HOME: path.join(home, "xdg") }) === path.join(home, "xdg", "aiwf"));
check("AIWF_CONFIG_HOME wins", resolveAiwfHeadDir({ ...envBase, AIWF_CONFIG_HOME: path.join(home, "forced"), XDG_CONFIG_HOME: path.join(home, "xdg") }) === path.join(home, "forced"));
const agentSeg = chrDotOmpAgent();
check("home agent dir", resolveHomeAgentDir(envBase) === path.join(home, agentSeg[0], agentSeg[1]));
function chrDotOmpAgent(): [string, string] { return ["." + "omp", "agent"]; }

const modelsTpl = path.join(tmpRoot, "models.yml.example");
const headTpl = path.join(tmpRoot, "machine-head.yml.example");
fs.writeFileSync(modelsTpl, ["providers:", "  p:", "    models:", "      - id: m1", ""].join(n));
fs.writeFileSync(headTpl, ["modelRoles:", "  default: p/m1", "  producer: p/m1", ""].join(n));

const head1 = path.join(tmpRoot, "head1");
const agent1 = path.join(tmpRoot, "agent1");
fs.mkdirSync(agent1);
fs.writeFileSync(legacyModelsPath(agent1), ["providers:", "  leg:", "    models:", "      - id: old", ""].join(n));
fs.writeFileSync(legacyConfigPath(agent1), ["modelRoles:", "  default: leg/old", "theme:", "  name: dark", "# ===== AIWORKFLOW PRODUCT", "ext: true", ""].join(n));
const mig = migrateLegacyOnce({ headDir: head1, agentDir: agent1, dryRun: false });
check("migrate imported", mig.status === "imported", mig);
check("migrate stripped legacy models", !fs.existsSync(legacyModelsPath(agent1)));
check("migrate kept legacy config", fs.existsSync(legacyConfigPath(agent1)));
check("migrate wrote shared models", fs.existsSync(headModelsPath(head1)));
check("migrate wrote shared roles", configHasModelRolesKey(fs.readFileSync(headConfigPath(head1), "utf8")));
check("migrate no product in shared", !fs.readFileSync(headConfigPath(head1), "utf8").includes("AIWORKFLOW PRODUCT"));

const mig2 = migrateLegacyOnce({ headDir: head1, agentDir: agent1, dryRun: false });
check("no re-import when head present", mig2.status === "skipped-head-present");

const head2 = path.join(tmpRoot, "head2");
const agent2 = path.join(tmpRoot, "agent2");
fs.mkdirSync(agent2);
fs.writeFileSync(legacyModelsPath(agent2), "providers: { x: 1 }" + n);
const dry = migrateLegacyOnce({ headDir: head2, agentDir: agent2, dryRun: true });
check("dry would import", dry.status === "dry-would-import");
check("dry no write", !fs.existsSync(head2));

const head3 = path.join(tmpRoot, "head3");
const seed = seedSharedHeadIfAbsent({ headDir: head3, modelsTpl, headTpl });
check("seed models", !!seed.seededModels && fs.existsSync(headModelsPath(head3)));
check("seed roles", !!seed.seededRoles && configHasModelRolesKey(fs.readFileSync(headConfigPath(head3), "utf8")));
const seed2 = seedSharedHeadIfAbsent({ headDir: head3, modelsTpl, headTpl });
check("seed no overwrite", !seed2.seededModels && !seed2.seededRoles && !!seed2.keptModels && !!seed2.keptRoles);

const shared = ["modelRoles:", "  default: a/b", "  producer: a/b", ""].join(n);
const ompCfg = ["theme:", "  name: x", "# ===== AIWORKFLOW PRODUCT", "product: 1", ""].join(n);
const synced = syncModelRolesToOmp(shared, ompCfg);
check("sync has roles", parseModelRoles(synced).default === "a/b");
check("sync keeps product", synced.includes("AIWORKFLOW PRODUCT") && synced.includes("product: 1"));
check("sync keeps theme", synced.includes("name: x"));

const head4 = path.join(tmpRoot, "head4");
const agent4 = path.join(tmpRoot, "agent4");
fs.mkdirSync(agent4);
fs.writeFileSync(legacyModelsPath(agent4), ["providers:", "  z:", "    models:", "      - id: z1", ""].join(n));
fs.writeFileSync(legacyConfigPath(agent4), ["modelRoles:", "  default: z/z1", "# ===== AIWORKFLOW PRODUCT", "p: 1", ""].join(n));
const ens = ensureSharedHead({ headDir: head4, agentDir: agent4, modelsTpl, headTpl });
check("ensure migrated", ens.migrate.status === "imported");
check("ensure synced", ens.synced);
check("ensure head binding", hasHeadBinding(head4));
check("ensure omp mirror has roles", configHasModelRolesKey(fs.readFileSync(legacyConfigPath(agent4), "utf8")));

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(fails ? (n + fails + " FAIL") : (n + "ALL GREEN"));
process.exit(fails ? 1 : 0);
