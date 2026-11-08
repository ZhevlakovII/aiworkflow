# core — AIWorkflow TS-native engine (pivot)

## Тулчейн

- **Node v24.11.1** исполняет `.ts` файлы нативно через type-stripping — build-шаг для
  dev/теста не нужен.
- Тесты: встроенный `node --test` (`node:test` + `node:assert`), запускаются напрямую
  на `.ts` файлах.
- **Bun не установлен** в этом окружении. Код пишется **runtime-агностичным**
  (Node + Bun-совместимым): без Bun-only API, без build-шага. OMP/OpenCode-шимы
  (более поздние куски пивота) исполняются во ВСТРОЕННОМ Bun этих харнессов — не в
  нашей установке — поэтому совместимость закладывается заранее.
- Ограничение Node type-stripping: НЕ поддерживает конструкции, требующие рантайм-
  трансформа — `enum`, `namespace`, parameter-properties, декораторы. Вместо этого:
  `type` / `interface` / union-типы / `as const`.
- Ноль внешних runtime-зависимостей (только `node:test`/`node:assert`).

## Запуск тестов

```
node --test core/test/policy.test.ts
```

(или из `core/`: `node --test test/*.test.ts` / `npm test`).

## Структура

- `src/policy/` — governance policy-модель (профили/концерны/резолюция).
  См. `docs/design/enforcement-governance-redesign-2026-09-18.md` раздел B.
