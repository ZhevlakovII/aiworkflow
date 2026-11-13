# INSTALL — накат AI Workflow

Один флоу, **четыре live flavor**. Выбор: `--flow` / `-Flow`. Первичный CLI: `node tools/aiwf.ts`.

| flavor | подложка | куда ставится | как включается |
|--------|----------|---------------|----------------|
| `omp` | Oh My Pi | глобал `~/.omp/agent/` | `--flow omp` |
| `opencode` | OpenCode | глобал `~/.config/opencode/` (или `$XDG_CONFIG_HOME/opencode`) | `--flow opencode` |
| `cursor` | Cursor | глобал `~/.cursor/` | `--flow cursor` |
| `dsh` | DeepSeek Harness | `~/.dsh/profiles/<profile>/plugins/aiwf/` + `.dsh-aiwf/` | `--flow dsh` |
| `all` (**дефолт**) | четыре live | все доступные | без флага / `--flow all` |

`claude` / `codex` / `both` **не** в installer UX (отвергаются с exit 2). Дерево `ports/claude/` может оставаться в репо, но инсталлер его не регистрирует.

Ключи: [docs/keys.md](docs/keys.md). Статус: [docs/status.md](docs/status.md).

> A3 §2.5: все flavor вендорят `core/src` в `<dest>/core/src` и rewrite на dest — не клон/кэш.

**Shared head** resolve: `AIWF_CONFIG_HOME` → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf` (Windows profile `.config/aiwf`, не %APPDATA%).
Файлы: `models.yml` + `config.yml` только `modelRoles`. Uninstall **никогда** не трогает shared head.

## Modes

Взаимоисключающие: `full` | `key` | `soft` | `yolo` (`-y` / `--yes` → yolo).

| Mode | Prompts | Head / roles | Absent CLI |
|------|---------|--------------|------------|
| `full` | flavors, scope, … | interactive | soft-skip |
| `key` | flavors + scope | YOLO defaults for roles | soft-skip |
| `soft` | none | vendor+render+mirror; **never** overwrite existing models.yml/modelRoles; seed head only if absent | soft-skip |
| `yolo` | zero | seed head if-absent; default-roles only if empty | soft-skip |

TTY без `--mode` → `full`. Non-TTY без флага → `yolo`.

Soft-skip absent harness CLI; **cursor-only** selection OK; abort если selected non-cursor set пуст после skip.

## 1. Prerequisites

| Компонент | Зачем |
|-----------|------|
| git, ast-index, node | hard-required |
| omp / opencode / dsh / cursor | soft harness (PATH; Cursor также Windows `Cursor.exe`) |
| PS 5.1+ or bash | thin bootstrap/setup shells |

Нет claude/codex в prereq UX.

## 2. Установка

### 2.0 Bootstrap (не clone-root)

bootstrap.ps1/sh: download zip+sha256 → verify → extract cache → `node tools/aiwf.ts setup …` → delete cache on success.

```bash
curl -fsSL https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.sh | bash
curl -fsSL .../bootstrap.sh | bash -s -- --yes --flow all
```

```powershell
irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1 | iex
$b = irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1
& ([scriptblock]::Create($b)) -Yes
& ([scriptblock]::Create($b)) -Flow all -Mode yolo
```

### 2.0b setup from checkout

```powershell
node tools/aiwf.ts setup --mode yolo
node tools/aiwf.ts setup --mode yolo --check
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Yes -Flow all
```

```bash
node tools/aiwf.ts setup --mode yolo
bash tools/setup.sh --yes --flow all
```

### 2.1 Per-flavor

```bash
node tools/aiwf.ts install omp
node tools/aiwf.ts install opencode --target /proj
node tools/aiwf.ts install cursor
node tools/aiwf.ts install dsh --target /proj
# thin shells still work:
bash tools/install.sh --check
bash tools/install-opencode.sh
bash tools/install-cursor.sh
bash tools/install-dsh.sh
```

### 2.2 Uninstall (managed only)

```bash
node tools/aiwf.ts uninstall omp
node tools/aiwf.ts uninstall all --check
```

Removes managed flavor trees + vendored core. **Never** deletes `~/.config/aiwf` (shared head).

### 2.3 Head

```bash
node tools/aiwf.ts head ensure
node tools/aiwf.ts head resolve
```

## 3. Soft / KeepAgents / MIR

- Soft mode: never overwrite existing shared head; may seed if entirely absent.
- KeepAgents: never overwrite existing `agents/*.md` at dest.
- omp/opencode: MIR tools (then `vendor-harness` restore); agents overlay in project mode.
- cursor: overlay skills/hooks; `<clone>` → dest abs.
- opencode: oneshot static agents after live render.

## 4. Publish zip

`publish.ps1` / `publish.sh` whitelist includes whole `tools/` → `tools/aiwf.ts` + `tools/install/**` ship in `aiworkflow-install.zip`.
