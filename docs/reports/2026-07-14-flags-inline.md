# Впаивание 6 core-флагов (удаление флага + фолбэк-пути) — 2026-07-14

Ветка: `fix/flags-inline` · Задача: `docs/prompts/prompt_flags_inline.md`.
Решение владельца: 6 core-флагов — это то, как приложение работает по умолчанию,
держать их за флагом не нужно. Убрать флаг = **удалить фолбэк-путь** (не просто
снять `if`). Откат — через git-историю, не через флаг.

Каждый флаг — **отдельный атомарный зелёный коммит**, от простых к крупным.
Поведение прод не менялось: во всех шести флаг в проде был ON, ON-ветка = как
сейчас. Тесты (backend + client) зелёные ПОСЛЕ каждого коммита.

## Что удалено по каждому флагу

| # | Флаг | Коммит | Удалено (фолбэк) | Осталось (единственный путь) |
|---|---|---|---|---|
| 1 | `vehicle_direction_shape` | `d056c34` | ветка «канонич. направление» (`shapeKeyOf → v.line`); `byRouteId` теперь всегда true | сшивка по `v.routeId` (backend всегда шлёт resolved) |
| 2 | `timed_trajectory` | `d55207d` | тернар эмиссии на backend; клиентский выбор ease-vs-timed; **66ms Timer-драйвер** (`_vehSampler`, `_startVehDriver(timed:)`), схлопнут в Ticker-only (`_stopVehSampler`→`_stopVehDriver`) | backend всегда эмитит `trajectory`; клиент всегда прикрепляет план (без плана — ease per-track); Ticker-драйвер |
| 3 | `schedule_fallback` | `6a6f357` | backend-гейт `&& getFlag` → `if(includeSchedule)`; клиентский фильтр «только live» (`shown = vehicles`) | расписание в списке всегда-вкл |
| 4 | `schedule_map` | `1a275c0` | backend-гейт `if(getFlag)` вокруг `scheduledMapVehicles` | scheduled-объекты на карте всегда-вкл (capped ≤8 маршрутов) |
| 5 | `live_position_only` | `a67fc63` | две else-ветки, пускавшие placeholder-ТС на карту (home_map_screen + stop_screen); подсказка «нет живых» стала безусловной | фильтр placeholder всегда-вкл (в **списке** прибытий они остаются) |
| 6 | `symbol_layer` | `37d8d49` | старый виджет-рендер: ветка `!_symbolLayerEnabled`+`WidgetLayer`, `_vehicleMarkers` (~60 строк), `_vehTick`, toggle-машинерия + `_reconcileVehicleSymbolLayers`, осиротевшие `_vehicleDetailZoom`/`_spiderfy` | GPU-символьный слой (`_addVehicleSymbolLayers`/`moving_object_layer`), добавляется на style-load безусловно |

### [STOP & ASK] пройдены до удаления
- **#6 `symbol_layer`**: владельцу показан точный список «мёртвое (виджет-ветка в
  home_map_screen) vs общий код». **Общий код не тронут:** `VehicleMarker`
  (`map_support.dart`) остаётся — его использует `live_vehicles_map.dart`
  (мини-карта ТС на экране остановки); `WidgetLayer` остаётся — маркер «моя
  позиция». Границу подтвердил владелец.
- **#5 `live_position_only`**: показано, что удаляются только две else-ветки, а
  хелперы `areaVehicleHasLivePosition`/`arrivalHasLivePosition` и `LiveVehiclesMap`
  не трогаются. Подтверждено.

### Лимиты воркера (расписание-«всегда-вкл») — не протекло
Проверены все вызовы `getArrivals({includeSchedule})`: список (`index.ts`) → true;
**map-fan-out (`vehicles.ts`) → `includeSchedule:false`** (никогда не платит
per-stop расписание); nearby (`nearbyArrivals.ts`) → capped `i<cap` (замерено).
Удаление `schedule_fallback`/`schedule_map` не трогает это пламбинг —
per-invocation стоимость на карте не выросла, утренний 503 не воспроизводится.
`schedule_map` — тот же capped-механизм (≤`MAX_SCHEDULED_ROUTES`), что и был.

## Итог
- В `featureFlags.ts` осталось **6 флагов**: `analytics_collect`, `analytics_show`,
  `coverage_map_show`, `coverage_on_main_map`, `nearby_list`, `nearby_sort_board`.
- Реестр `docs/feature-flags.md` обновлён (6 строк убраны).
- Тесты: backend **102**, client **176**, `tsc`/`analyze` чисто.

## В проде (2026-07-14)
- Влито в `main` (fast-forward, −395/+172), тесты на слитом main зелёные
  (backend 102, client 176).
- Задеплоено: backend (`stigla-api.theoutlines.xyz`), web (`--branch=main`;
  sha кастомного домена = локальный билд `c5c010ff…`).
- Проверка прода: `/api/v1/config` отдаёт **6 флагов** (ни одного впаянного);
  `/vehicles/nearby` — HTTP 200, 19 ТС, все с `trajectory`; `/arrivals?stop=` —
  HTTP 200, список с плановыми. Core работает.
- **6 осиротевших KV-ключей удалены** из прод-KV (`flag:symbol_layer`,
  `flag:timed_trajectory`, `flag:live_position_only`, `flag:vehicle_direction_shape`,
  `flag:schedule_fallback`, `flag:schedule_map`). Staging-KV пуст — там нечего.
- Отдельной командой владельца в этой же сессии **включён `coverage_on_main_map`
  в проде** (`flag:coverage_on_main_map=1`) — это единственное изменение видимого
  поведения; heatmap покрытия теперь показывается на основной карте при зум-ауте.
  Откат мгновенный: `flag:coverage_on_main_map=0`.

## Как проверить (владельцу, без терминала)
Это рефакторинг «убрать переключатели» — видимое поведение не меняется (в проде все
6 и так были ON). После деплоя:
1. Открой прод-карту **https://stigla.theoutlines.xyz** — ТС двигаются плавно
   (символьный слой + таймд-траектория), едут по правильной геометрии, placeholder
   не висят на остановках, ночью/в межпик видно расписание. Всё как до рефактора.
2. Экран остановки — мини-карта подъезжающих ТС по-прежнему работает (это тот самый
   общий `VehicleMarker`, который мы сохранили).
3. Прод `/api/v1/config` покажет уже **6 флагов** (шести core больше нет в списке).
