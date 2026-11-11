# INSTALL — накат AI Workflow

Один флоу, **несколько подложек (flavor)**. Выбор: `--flow` / `-Flow`.

| flavor | подложка | куда ставится | как включается |
|--------|----------|---------------|----------------|
| `omp` | Oh My Pi | глобал `~/.omp/agent/` | `-Flow omp` |
| `claude` | Claude Code | глобал `~/.claude/` | `-Flow claude` |
| `opencode` | OpenCode | глобал `~/.config/opencode/` (или `$XDG_CONFIG_HOME/opencode`) | `-Flow opencode` |
| `cursor` | Cursor | глобал `~/.cursor/` | `-Flow cursor` |
| `dsh` | DeepSeek Harness | `~/.dsh/profiles/<profile>/plugins/aiwf/` + `.dsh-aiwf/` | `-Flow dsh` |
| `all` (**дефолт**) | omp+claude+opencode+**cursor**+**dsh** | все пять | без флага |
| `both` | omp+claude+opencode | три (**без** cursor/dsh) | `-Flow both` — не alias `all` |

Ключи: [docs/keys.md](docs/keys.md). Статус: [docs/status.md](docs/status.md).

> A3 §2.5: все flavor вендорят `core/src` в `<dest>/core/src` и rewrite на dest — не клон/кэш.

**Shared head** resolve: `AIWF_CONFIG_HOME` → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf` (Windows profile .config/aiwf, не %APPDATA%).
Файлы: `models.yml` + `config.yml` только `modelRoles`. Тема в flavor OMP config. §8 — migrate/sync.

**OMP:** `~/.omp/agent/`; -Target → project `.omp` + vendored core. modelRoles в home config = зеркало shared head.
**Claude:** abs paths inside dest `<dest>/core/src`, не `~/.aiworkflow`.

## 1. Prerequisites

| Компонент | Зачем |
|-----------|------|
| git, ast-index | hard-required |
| Node >=24 | когда flavor ставится (render/vendor) |
| omp/claude/opencode/dsh | soft-optional harness CLI на multi-flow; solo flow hard для этого flow |
| PS 5.1+ or bash | installer |

Soft-optional: нет CLI → skip flavor. Abort если нет ни одного selected harness (искл. -Flow cursor).
Опц.: LM Studio в shared head models.yml; Java 21; codex npm.

## 2. Установка

### 2.0 Bootstrap (не clone-root)

bootstrap.ps1/sh **не** клонируют в `~/.aiworkflow` как runtime root.
1. Download aiworkflow-install.zip + .sha256 (latest / pin-tag / pin-URL https allowlist hosts).
2. Verify SHA-256 before extract/stamp; fail → keep partial, print path.
3. Extract to temp cache only (not dest/head/`~/.aiworkflow`).
4. setup/install from cache: head seed/import, modelRoles sync, vendor, live render, rewrite.
5. Success → delete zip+cache. Failure → retain+print path.
6. Do not delete existing `~/.aiworkflow`. Repeat = re-download+verify.

Flow = setup: omp|claude|opencode|cursor|dsh|all|both. Default **all includes cursor+dsh**. both excludes them.

```bash
curl -fsSL https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.sh | bash
curl -fsSL .../bootstrap.sh | bash -s -- --yes --flow claude
```

```powershell
irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1 | iex
$b = irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1
& ([scriptblock]::Create($b)) -Yes
& ([scriptblock]::Create($b)) -Flow all
```

Help: bootstrap -h. bootstrap.ps1 ASCII-only.

### 2.0b setup from checkout

setup.*: prereq → shared-head seed-if-absent + legacy import → setup_roles → install.* → omp smoke if omp installed.
Never overwrite real shared head. Harness CLI soft-optional.

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Yes -Flow all
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow both
```

```bash
bash tools/setup.sh --yes --flow all
bash tools/setup.sh --flow dsh
```

### 2.1 installer-only

tools/install.* vendor `core/src` + rewrite (install-runtime.ts) + render + product splice; modelRoles from shared head.

### 2.2 flows

`--flow omp|claude|opencode|cursor|dsh|all|both`. claude/cursor-only skip head seed.

### 2.3 Claude

`~/.claude` agents/commands/settings + vendored `core/src`; command paths abs in dest.

### 2.4 OpenCode path-rewrite REQUIRED

Stale claim OpenCode needs no path-rewrite because neighbor `../lib` is relative: **FALSE**.
OpenCode already rewrote `(../)+core/src/` (was absolute clone). Fix: rewrite to **vendored dest**.
1) vendor core 2) file-relative TS imports to dest core 3) leave ../lib 4) idempotent -Check.
Oneshot: opencode run + aiwf-oneshot/aiwf-reason (no omp -p). Missing omp on opencode-only OK.

### 2.5 A3

All installers incl cursor/dsh. Vendor before rewrite. Overlay/KeepAgents. seed-if-absent maps. managed gitignore.

### 2.6 rewrite rule

TS file-relative → dest core; cwd hooks/commands → abs inside dest; never cache or `~/.aiworkflow` as runtime root.

## 3 Deploy `~/.omp/agent/`

tools hooks agents core/src docs; config theme+product + modelRoles mirror. models.yml only on shared head after migrate.

## 4 Verify

```bash
omp -p "Reply exactly: LOADED" --yolo
test -d ~/.omp/agent/core/src && echo vendor-ok
```

## 5 Project

zonemap real zones; project `.omp/models.yml` / `.dsh-aiwf/models.yml` win over shared; workflow ignored; git>=1 commit.

## 6 Queue

node core/src/ops/queue-rpc-cli.ts --cwd <project>

## 7 Update / uninstall

### Update = re-bootstrap

latest or pin (`AIWF_RELEASE`) + SHA verify again; or setup/install from fresh tree.
- does not overwrite shared head
- does not clobber project seed-if-absent / project models.yml
- still syncs modelRoles into OMP config from shared head
- re-vendors dest core + rewrite + live render
Not: git pull in `~/.aiworkflow` as product update.

### Uninstall = installer flag

- removes managed flavor trees incl vendored `<dest>/core/src` and mirrored canon agents
- may clear leftover download cache
- does not remove shared head without explicit head purge
- does not remove OMP modelRoles mirror without that purge
- does not delete `~/.aiworkflow`
- does not delete user project seed-if-absent without explicit purge

## 8 Shared head

Resolve: AIWF_CONFIG_HOME → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf`.
Seed-if-absent omp/opencode/dsh (not claude/cursor-only).
Legacy one-shot import when head absent; after successful copy **strip** legacy models.yml; failed copy does not delete.
Do **not** strip modelRoles from OMP config as sole store.
Sync shared→OMP modelRoles on seed/import/setup_roles. User edits shared head. OpenCode/DSH ignore OMP mirror.
Project models overlays beat shared list. Home agent models.yml not read after migrate.

## 9 Delegation

claude|omp|codex|omp-fanout. OpenCode oneshots via opencode run from shared head models — no silent omp -p.

## 10 Telemetry

NDJSON; stats-cli under core/src/ops.

## Troubleshooting

UTF-8 config; SHA mismatch keeps partial; after cache wipe reinstall for dest core; home agent models.yml after migrate is not SSOT.

