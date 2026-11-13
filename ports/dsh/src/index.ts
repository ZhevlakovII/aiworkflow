/**
 * AI Workflow DSH Cordis plugin entry — registers session/rails tools + pre-execute zone-guard.
 */
import type { CordisContext } from "../tools/_lib/cordis.ts";
import { registerZoneGuard } from "../hooks/pre/zone-guard.ts";
import { registerGatedCommit } from "../tools/commit.ts";
import { registerGatedPush } from "../tools/push.ts";
import { registerDesignSession } from "../tools/design_session.ts";
import { registerScaffoldSession } from "../tools/scaffold_session.ts";
import { registerRoadmapSession } from "../tools/roadmap_session.ts";
import { registerExecuteSession } from "../tools/execute_session.ts";
import { registerGatedMerge } from "../tools/merge.ts";
import { registerCodeSearch } from "../tools/code_search.ts";
import { registerOutline } from "../tools/outline.ts";
import { registerCallers } from "../tools/callers.ts";
import { registerDshTelemetry } from "../hooks/dsh-telemetry.ts";
import { registerQueueRunner } from "../hooks/queue-runner.ts";
import { registerPlan } from "../tools/plan.ts";
import { registerSynthesize } from "../tools/synthesize.ts";
import { registerArchiveSpec } from "../tools/archive_spec.ts";

export type { CordisContext };

/** Cordis `activate(ctx)` / plugin default export. */
export default function activate(ctx: CordisContext): void {
  registerDshTelemetry(ctx);
  registerQueueRunner(ctx);
  registerZoneGuard(ctx);
  registerGatedCommit(ctx);
  registerGatedPush(ctx);
  registerGatedMerge(ctx);
  registerDesignSession(ctx);
  registerScaffoldSession(ctx);
  registerRoadmapSession(ctx);
  registerExecuteSession(ctx);
  registerCodeSearch(ctx);
  registerOutline(ctx);
  registerCallers(ctx);
  registerPlan(ctx);
  registerSynthesize(ctx);
  registerArchiveSpec(ctx);
}

export function registerAiwfDshTools(ctx: CordisContext): void {
  activate(ctx);
}
