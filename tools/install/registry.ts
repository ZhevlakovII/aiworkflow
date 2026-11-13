// registry — declarative flavor rows.
// Contract: AD-flavor-registry — dest, vendor-harness, render, mirror/MIR vs overlay, KeepAgents, gitignore.

import * as path from "node:path";
import { homeDir, xdgConfigHome } from "./common.ts";

export type FlavorId = "omp" | "opencode" | "cursor" | "dsh";

/** How consumer tools are laid down relative to port SRC. */
export type MirrorKind = "mir" | "overlay";

/**
 * One registry row per live flavor. Drive shared install pipeline from these fields.
 */
export interface FlavorSpec {
  id: FlavorId;
  /** Port SRC path under repo (ports/<id>/). */
  portSrc: string;
  /** Whether to vendor core/harness into dest (install-runtime vendor-harness). */
  vendorHarness: boolean;
  /** Whether to run render/adapters at install time for agents. */
  render: boolean;
  /** Mirror (/MIR) vs overlay copy semantics for tools/agents. */
  mirror: MirrorKind;
  /** Forward KeepAgents: never overwrite existing agents/*.md at dest. */
  keepAgents: boolean;
  /** Whether installer should ensure/update dest .gitignore entries. */
  gitignore: boolean;
  /** Optional harness CLI name for soft-skip probes. */
  harnessCli?: string;
  /** Resolve consumer destination (global or project-scoped). */
  resolveDest: (target?: string) => string;
  /** Optional secondary dest (e.g. dsh overlay, opencode.json parent). */
  resolveExtra?: (target?: string) => string | undefined;
}

/** Four live flavors. */
export const FLAVOR_REGISTRY: Record<FlavorId, FlavorSpec> = {
  omp: {
    id: "omp",
    portSrc: "ports/omp",
    vendorHarness: true,
    render: true,
    mirror: "mir",
    keepAgents: true,
    gitignore: true,
    harnessCli: "omp",
    resolveDest: (target) =>
      target && target.trim()
        ? path.join(target, ".omp")
        : path.join(homeDir(), ".omp", "agent"),
  },
  opencode: {
    id: "opencode",
    portSrc: "ports/opencode",
    vendorHarness: true,
    render: true,
    mirror: "mir",
    keepAgents: true,
    gitignore: true,
    harnessCli: "opencode",
    resolveDest: (target) =>
      target && target.trim()
        ? path.join(target, ".opencode")
        : path.join(xdgConfigHome(), "opencode"),
  },
  cursor: {
    id: "cursor",
    portSrc: "ports/cursor",
    vendorHarness: true,
    render: true,
    mirror: "overlay",
    keepAgents: true,
    gitignore: true,
    harnessCli: "cursor",
    resolveDest: (target) =>
      target && target.trim()
        ? path.join(target, ".cursor")
        : path.join(homeDir(), ".cursor"),
  },
  dsh: {
    id: "dsh",
    portSrc: "ports/dsh",
    vendorHarness: true,
    render: true,
    mirror: "mir",
    keepAgents: true,
    gitignore: false,
    harnessCli: "dsh",
    resolveDest: (target) => {
      void target;
      const dshHome = process.env.DSH_HOME || path.join(homeDir(), ".dsh");
      const profile = process.env.AIWF_DSH_PROFILE || "headless";
      return path.join(dshHome, "profiles", profile, "plugins", "aiwf");
    },
    resolveExtra: (target) =>
      target && target.trim() ? path.join(target, ".dsh-aiwf") : undefined,
  },
};

export function getFlavorSpec(id: FlavorId): FlavorSpec {
  return FLAVOR_REGISTRY[id];
}

export function listFlavorSpecs(): FlavorSpec[] {
  return (Object.keys(FLAVOR_REGISTRY) as FlavorId[]).map((id) => FLAVOR_REGISTRY[id]);
}

/** Legacy `dest` string for display (global default). */
export function flavorDestLabel(id: FlavorId): string {
  return FLAVOR_REGISTRY[id].resolveDest();
}
