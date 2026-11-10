# Карта репозитория

Продуктовое дерево AI Workflow (нейтральный к харнессу SDLC-слой).

| Путь | Роль |
|------|------|
| `canon/` | SSOT ролей (+ пример `zonemap.yml`, не сеется; `delegation` скелет). Роли → port `agents/` на install/render. |
| `core/` | Движок: рельсы L1–L3, judge/stage, gate-lint, render, command-hook / zone-guards. |
| `tools/` | Инсталлеры, адаптеры (`tools/adapters/<client>.yml`), setup/bootstrap, шаблоны. |
| `ports/<client>/` | **SRC SSOT порта** (omp, cursor, opencode, claude, …). В этом репо не живой корень харнесса. |
| `.workflow/` | Task-файлы (иммутабельные контракты), ledger, журналы стадий, active-zone (рантайм). |

## Куда ставит инсталлер

Инсталлеры копируют `ports/<client>/` → у consumer `.<client>/` (проект) или глобальный путь flavor (`~/.omp/agent`, `~/.cursor`, …). В этом product-checkout **нет** live dogfood-деревьев `.<client>/` в корне.

Проектные оверлеи (опциональная заполненная `zonemap.yml` / `delegation.yml`, свои агенты) живут в **consumer**-проекте, не в canon. Пустой zonemap инсталлер **не** сеет; отсутствие файла нормально → executor.

## Макро-путь

Дефолт: `classify → design? → execute → gate → report`. Каталог стадий (7) и opt-in plan/scaffold — в `docs/keys.md`.

## Живые доки

- `docs/map.md` — этот файл (RU SSOT)
- `docs/status.md` — текущий статус продукта
- `docs/keys.md` — ключевые решения
- `docs/en/` — английское зеркало (распределение позже)
- `docs/archive/` — история (ADR, research); только локальный канон, не в публичном dist
