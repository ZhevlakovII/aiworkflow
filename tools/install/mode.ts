// mode — mutually exclusive installer modes + TTY-aware resolver.
// Contract: AD-mode-table-and-resolver (full|key|soft|yolo; default full on TTY; non-TTY → yolo).

export type Mode = "full" | "key" | "soft" | "yolo";

export class ModeError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "ModeError";
  }
}

const MODE_SET = new Set<Mode>(["full", "key", "soft", "yolo"]);

function flagMode(argv: string[]): Mode | undefined {
  if (argv.includes("-y") || argv.includes("--yolo") || argv.includes("--yes")) return "yolo";
  if (argv.includes("--soft")) return "soft";
  if (argv.includes("--key")) return "key";
  if (argv.includes("--full")) return "full";
  const i = argv.indexOf("--mode");
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v || v.startsWith("-")) throw new ModeError("--mode requires full|key|soft|yolo");
    if (!MODE_SET.has(v as Mode)) throw new ModeError(`unknown --mode ${v} (want full|key|soft|yolo)`);
    return v as Mode;
  }
  return undefined;
}

/** Collect explicit mode tokens to detect mutex conflicts. */
function explicitModes(argv: string[]): Mode[] {
  const found: Mode[] = [];
  if (argv.includes("-y") || argv.includes("--yolo") || argv.includes("--yes")) found.push("yolo");
  if (argv.includes("--soft")) found.push("soft");
  if (argv.includes("--key")) found.push("key");
  if (argv.includes("--full")) found.push("full");
  const i = argv.indexOf("--mode");
  if (i >= 0 && i + 1 < argv.length && MODE_SET.has(argv[i + 1] as Mode)) {
    found.push(argv[i + 1] as Mode);
  }
  return found;
}

/**
 * Resolve installer mode from argv flags.
 * Flags (mutex): --mode <name> | --full | --key | --soft | --yolo | -y | --yes
 * Default: full when isTTY, else yolo.
 */
export function resolveMode(argv: string[], isTTY: boolean): Mode {
  const explicit = explicitModes(argv);
  const uniq = [...new Set(explicit)];
  if (uniq.length > 1) {
    throw new ModeError(`conflicting mode flags: ${uniq.join(", ")}`);
  }
  const fromFlag = flagMode(argv);
  if (fromFlag) return fromFlag;
  return isTTY ? "full" : "yolo";
}
