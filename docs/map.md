# Карта репозитория

Продуктовое дерево AI Workflow (нейтральный к харнессу SDLC-слой).

| Путь | Роль |
|------|------|
| `canon/` | SSOT ролей (+ пример `zonemap.yml`, не сеется; `delegation` скелет). Роли → port `agents/` на install/render. |
| `core/` | Движок: рельсы L1–L3, judge/stage, gate-lint, render, command-hook / zone-guards. |
| `tools/` | Node CLI `tools/aiwf.ts` + `tools/install/**`, thin setup/bootstrap shells, адаптеры, шаблоны. |
| `ports/<client>/` | **SRC SSOT порта** (omp, cursor, opencode, dsh; `ports/claude/` может оставаться unused). В этом репо не живой корень харнесса. |
| `.workflow/` | Task-файлы (иммутабельные контракты), ledger, журналы стадий, active-zone (рантайм). |

## Куда ставит инсталлер

Инсталлеры копируют `ports/<client>/` → у consumer `.<client>/` (проект) или глобальный путь flavor (`~/.omp/agent`, `~/.cursor`, …). В этом product-checkout **нет** live dogfood-деревьев `.<client>/` в корне.

Проектные оверлеи (опциональная заполненная `zonemap.yml` / `delegation.yml`, свои агенты) живут в **consumer**-проекте, не в canon. Пустой zonemap инсталлер **не** сеет; отсутствие файла нормально → executor.


## Shared head + runtime dest

- Shared head (models/modelRoles): `AIWF_CONFIG_HOME` → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf`.
- Install dest (each flavor) vendors `core/src` at `<dest>/core/src`; bootstrap cache and `~/.aiworkflow` are not runtime roots.
- Live installer flavors: `omp` | `opencode` | `cursor` | `dsh` (preset `all`). Modes: `full` | `key` | `soft` | `yolo`. No `claude`/`codex`/`both` in installer UX.
- Uninstall = managed flavor trees only; shared head never purged.
## Макро-путь

Роли: producer · critic · explorer · **roadmapper** · executor (`scaffolder` legacy).

Дефолт: `classify → design(spec) → roadmap → execute → gate → report`. Каталог (без plan/scaffold как стадий) и marker `generation: spec-roadmap` — в `docs/keys.md`.

## Живые доки

- `docs/map.md` — этот файл (RU SSOT)
- `docs/status.md` — текущий статус продукта
- `docs/keys.md` — ключевые решения
- `docs/en/` — английское зеркало (распределение позже)
- `docs/archive/` — история (ADR, research); только локальный канон, не в публичном dist
