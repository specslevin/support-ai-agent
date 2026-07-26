# Навык: вёрстка макетов в Figma через figma-mcp-go

## Что это
MCP figma-mcp-go связан с плагином-мостом в Figma Desktop (127.0.0.1:1994, без токена).
Инструменты mcp__figma-mcp-go__*: чтение (get_document/get_node/get_nodes_info/get_metadata/
search_nodes/save_screenshots), создание (create_frame/create_text/…), set_auto_layout,
resize_nodes, set_fills/set_strokes, set_corner_radius, bind_variable_to_node,
apply_style_to_node, delete_nodes. Плагин должен быть запущен в Figma Desktop.

Актуальная работа — **тёмная тема карточки заявки v3**. Светлые макеты на странице
(узлы 69:* — 71:*) это история, ориентироваться на них НЕ надо.

## Главный метод сборки
- СНАРУЖИ ВНУТРЬ: сначала фрейм-контейнер → СРАЗУ set_auto_layout → ПОТОМ клади детей.
  Никаких абсолютных x/y у детей — позицию задаёт auto-layout. (Если налепить детей с
  координатами, а auto-layout навесить последним — высота hug не пересчитывается, фрейм
  застревает, родитель кладёт следующий блок поверх.)
- Крупную задачу дели на короткие шаги — меньше риск обрыва.
- Идемпотентность: в начале шага search_nodes по имени → если найдено, delete_nodes →
  потом создавай. Повтор безопасен, без дублей.

## Грабли auto-layout (СОБЛЮДАТЬ ВСЕГДА)
1. У КАЖДОГО HORIZONTAL-фрейма ставь counterAxisSizingMode=AUTO — иначе высота застревает
   ~100px и раздувает строки/бейджи/ячейки.
2. Ряды фиксированной ширины: primaryAxisSizingMode=FIXED + потом resize_nodes width=N.
   На hug по главной оси НЕ надейся — ширина «подстроится под контент» и разъедется.
   После сборки ОБЯЗАТЕЛЬНО проверь get_node: ширина должна быть ровно N.
3. Перенос layoutWrap=WRAP работает ТОЛЬКО при primaryAxisSizingMode=FIXED + заданной
   ширине. Иначе фрейм тянется в одну строку и вылезает за контейнер.
4. Заголовок «центрируется» из-за counterAxisAlignItems=CENTER у блока — для выравнивания
   влево ставь блоку counterAxisAlignItems=MIN (правка textAlign у текста не помогает).
5. Любому ряду, где элементы РАЗНОЙ высоты (бейдж + текст + дата, метка + каретка ▾),
   ставь counterAxisAlignItems=CENTER — иначе мелкие элементы прилипают к верхней кромке.
6. Вертикальный блок фикс-ширины: primaryAxisSizingMode=AUTO (высота по контенту) +
   counterAxisSizingMode=FIXED + задать ширину resize_nodes.
7. Перенос длинного текста: задай текстовому узлу фиксированную ширину (resize) +
   textAutoResize=HEIGHT — тогда переносится. Без этого текст уедет в одну строку и
   обрежется.

## Скругления и радиусы

**cornerRadius и обводки НЕЛЬЗЯ задать при создании фрейма.** Это ОТДЕЛЬНЫЕ вызовы
`set_corner_radius` и `set_strokes`. Прочитал в задании «cornerRadius 8, обводка 1px» —
значит после сборки обязан сделать эти вызовы явно, иначе углы останутся прямыми, а
обводки не будет вовсе. Это самый частый пропуск. `set_corner_radius` принимает массив
nodeIds (можно все бейджи одним вызовом), `set_strokes` — только ОДИН nodeId за вызов.

**Порядок важен:** `set_strokes` / `set_fills`, вызванные ПОСЛЕ
`bind_variable_to_node`, СТИРАЮТ привязку переменной. Сначала ставь обводку/толщину,
потом привязывай переменную. Если порядок нарушен — перебиндить заново.

`set_corner_radius` **умеет отдельные углы** (topLeftRadius/topRightRadius/
bottomLeftRadius/bottomRightRadius). Вызов вернёт ошибку `in postMessage: Cannot unwrap
symbol` — это косметика сериализации ответа, **правка применяется**. Проверяй через
get_node: cornerRadius станет "mixed". Не считай вызов провалившимся и не повторяй.

Нужно для таблиц из auto-layout-строк: шапке радиус только сверху, последней строке
только снизу. Если поставить uniform всем — на стыках со средними (радиус 0) строками
видны выкусы цвета контейнера-разделителя.

## Цвет — ТОЛЬКО через переменные, не хексами
Коллекция `support-ai-agent`, `VariableCollectionId:74:211`, режим `74:0`.
Применять `bind_variable_to_node(nodeId, variableId, field)`, field = `fillColor`
(заливка фрейма ИЛИ цвет текста) или `strokeColor`. Если у узла есть и заливка, и
обводка — ДВА вызова.

| Роль | Переменная | variableId | HEX |
|---|---|---|---|
| акцент, лайм-кнопки, ссылки | accent/default | VariableID:74:212 | #99D52A |
| ховер акцента | accent/hover | VariableID:74:213 | #536716 |
| фон страницы | bg/base | VariableID:74:214 | #0A0A0A |
| фон тёмный | bg/darker | VariableID:74:215 | #171717 |
| поля, вложенные поверхности | bg/frame | VariableID:74:216 | #1E1E1E |
| фон блока/карточки | bg/card | VariableID:74:217 | #252D25 |
| ховер строки | bg/card-hover | VariableID:74:218 | #1C231C |
| основной текст | text/primary | VariableID:74:219 | #FFFFFF |
| вторичный текст (данные) | text/secondary | VariableID:74:220 | #ACC3A7 |
| приглушённый текст | text/muted | VariableID:74:221 | #7A8A7A |
| **текст на залитой цветной пилюле** | text/on-accent | VariableID:74:243 | #000000 |
| обводки, разделители | stroke/default | VariableID:74:222 | #404040 |
| инфо (синий) | state/info | VariableID:74:223 | #60A5FA |
| предупреждение (янтарь) | state/warning | VariableID:74:224 | #F3BA2F |
| успех (зелёный) | state/success | VariableID:74:225 | #22C55E |
| ошибка (оранжевый) | state/orange | VariableID:74:226 | #FB923C |
| ярко-зелёный | green/bright | VariableID:74:227 | #96FF1F |
| средне-зелёный | green/medium | VariableID:74:228 | #80EE64 |
| тёмно-зелёный | green/dark | VariableID:74:229 | #3F513F |
| фон нейтрального бейджа | overlay/white-8 | VariableID:74:230 | #FFFFFF14 |
| тинт акцента | overlay/accent-15 | VariableID:74:231 | #99D52A26 |
| тинт предупреждения | overlay/warning-15 | VariableID:74:232 | #F3BA2F26 |
| слабый тинт предупреждения | overlay/warning-5 | VariableID:74:233 | #F3BA2F0D |
| обводка предупреждения | overlay/warning-50 | VariableID:74:234 | #F3BA2F80 |
| тинт успеха | overlay/success-15 | VariableID:74:244 | #22C55E26 |

Правила:
- **Прозрачную заливку `#00000000` не трогать** — переменной под неё нет. Таких
  контейнеров много (шапки, панели, подвалы, ячейки таблиц).
- Цвета, которого нет в таблице, **не подгонять к ближайшему**. Выписать в отчёт:
  nodeId, имя, HEX, поле. Пусть решает ведущий.
- Различай роль: один и тот же HEX может быть и фоном, и текстом. Чёрный текст на
  лаймовой/янтарной пилюле — это `text/on-accent`, а НЕ `bg/base`.
- API не отдаёт факт привязки: `get_node` после бинда покажет тот же HEX. Отчитывайся
  числом успешных вызовов, проверять будет ведущий.

## Типографика — ТОЛЬКО через текст-стили
`create_text` НЕ умеет задавать межстрочный интервал. Поэтому: создал текст →
`apply_style_to_node(nodeId, styleId)`.

| Стиль | Параметры | styleId |
|---|---|---|
| Heading/Block | Inter Bold 15/18 — заголовки блоков v3 | `S:b25238f680620e13aad4f97c32337bb68eab8f0e,` |
| H2 | Inter Bold 20/28 | `S:73cebb05e254740d8c697e4228e1f65bf2cce324,` |
| H3 | Inter Medium 18/24 | `S:bc2b051209b9a4141c9435a3f64dec1a054d536d,` |
| H4 | Inter Bold 16/24 | `S:7ddfd643f8fd4f5195cf31010058aaa007e9aeb0,` |
| Body | Inter Regular 14/20 | `S:84c90d33edc177f5805072598d2b6f1c8dfe76e2,` |
| Body Bold | Inter Bold 14/20 | `S:224c185e6f4a9b86cc242c72c3adbe3abe065ac5,` |
| Body Small | Inter Regular 13/20 — текст данных, черновики | `S:a492d88fa4ceced6f03d116dd0a0ffef30c337b7,` |
| Body Small Medium | Inter Medium 13/20 — акцентные данные, метки кнопок | `S:74502287f2c013b80b0ad2eae1d85c27e23b3154,` |
| Caption | Inter Regular 12/16 | `S:97dd05ce89caf96f5411c4ab1e033e127f1691d1,` |
| Caption Medium | Inter Medium 12/16 — ссылки-действия | `S:35bc12ccda98f2d338ebaa20e721dc55cc66b0e9,` |
| Caption Bold | Inter Bold 12/16 | `S:0df32609b01219595b4945cd0869a82022dc418f,` |
| Meta | Inter Regular 11/16 — даты, мета-строки | `S:edd76089ec7c236820fd70545f7c690e6a93ff77,` |
| Meta Medium | Inter Medium 11/16 — подписи колонок, пилюли | `S:fd92802113a005f746871ccd4e032ae59fb2ce87,` |
| Micro | Inter Regular 10/14 — тумблеры, ✎ | `S:7924ad3b74171182de9d131630d0fe3d89feaed3,` |
| Badge | Inter Medium 9/12 +0.4px — бейджи ЗАГЛАВНЫМИ | `S:b4e0cec3a52cffb4ecedd84761df0228a0244043,` |

**Веса в ките только Regular / Medium / Bold. SemiBold НЕ СУЩЕСТВУЕТ** — `create_text`
с fontStyle='SemiBold' упадёт. Для кнопок бери Medium.

## Иконки
**Эмодзи как иконки НЕ использовать** (🗺 💡 📎 🔒 ⏳ и пр.) — рендерятся цветной
картинкой ОС, выбиваются из монохромной сетки и не подчиняются fills/переменным.
Разрешены монохромные глифы: `✦ ✎ ▾ → ↓ · Δ ✓ ⚠`.

## Раскладка карточки v3
Левая (рабочая) колонка — ширина **872**, внутренняя **840** (padding 16).
Правый рельс — ширина **464**, внутренняя **432**.
Блок: fill `bg/card`, cornerRadius 8, padding 16, VERTICAL auto-layout, itemSpacing 12.

Собранные блоки — эталоны стиля, сверяйся с ними:
`74:111` ① Разбор · `74:2` ② Телеметрия и вердикт · `74:188` ③ Ответ ·
`74:43` Вложения · `74:86` Связанные · `73:194` схема раскладки.

## Рецепты
- Пилюля-статус (контурная): HORIZONTAL hug, cornerRadius 999, padding 3/8-10,
  fill `bg/frame`, stroke = цвет состояния, текст = тот же цвет состояния, стиль Meta Medium.
- Пилюля-статус (залитая): fill = тинт состояния (overlay/*-15), текст = цвет состояния.
  Залитая насыщенным цветом + белый текст НЕ проходит по контрасту — так не делать.
- Бейдж вида/типа: HORIZONTAL hug, cornerRadius 4, padding 2/6, fill `overlay/white-8`,
  текст `text/muted`, стиль Badge, ЗАГЛАВНЫМИ.
- Строка таблицы: HORIZONTAL, ширина FIXED = ширине таблицы, counterAxisSizingMode=AUTO,
  ячейки = фреймы фикс-ширины с padding 10.
- Разделители в таблице: контейнер fill `stroke/default` + padding 1 + itemSpacing 1,
  строки поверх — линии проступают в зазорах.
- Поле ввода/черновика: VERTICAL, ширина FIXED, primaryAxisSizingMode=AUTO, padding 12,
  fill `bg/frame`, stroke `stroke/default`, cornerRadius 8; текст внутри — фикс-ширина
  (внутренняя минус 24) + textAutoResize=HEIGHT + стиль Body Small.
- Метрик-чип: VERTICAL fill `bg/frame` cornerRadius 8 padding 12 gap 4 → подпись
  (Meta, `text/muted`) + значение (Body Small Medium, `text/primary`).
- Кнопка primary: HORIZONTAL hug, padding 8/14, cornerRadius 8, fill `accent/default`,
  текст `text/on-accent` стилем Body Small Medium.
- Кнопка secondary: то же, но fill `bg/frame` + stroke `stroke/default`, текст
  `text/secondary`.

## Проверка (обязательно)
- ВСЕГДА проверяй скриншотом: save_screenshots (outputPath ОБЯЗАТЕЛЬНО внутри рабочей
  директории проекта, иначе ошибка) → открой PNG и посмотри.
- Файл по тому же outputPath второй раз не перезапишется — ошибка «file already
  exists». Меняй имя (…_v2.png).
- get_screenshot (base64) для крупных узлов не влезает — не используй.
- Размер в ответе бывает в порядке высота×ширина — сверяй по метаданным save_screenshots.
- В отчёте верни: id узлов, фактические ширины из get_node (а не задуманные), число
  вызовов bind/apply_style, список незнакомых цветов, подтверждение отсутствия
  наложений и переполнений.
- Не выдавай желаемое за факт: если чего-то не сделал или инструмент отказал — напиши
  прямо. Ведущий перепроверяет всё скриншотом и маркерным прогоном переменных.
