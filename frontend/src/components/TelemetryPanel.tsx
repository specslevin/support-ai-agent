import { useState } from 'react'
import { Sparkles, AlertTriangle } from 'lucide-react'
import type { AutomationTelemetry, VerdictSource } from '../types'

interface TelemetryPanelProps {
  telemetry: AutomationTelemetry | null
  category: string | null           // вердикт: «Глушение», «Данные верны», …
  confidence: number | null         // 0..1
  needsReview: boolean
  autoEligible?: boolean            // можно отправлять авто-ответ
  subtitle?: string | null          // подпись справа в шапке, например «Е456КХ163 · 21.07.2026»
  reasoning?: string | null         // обоснование вердикта от ИИ — под метриками
  /** Чем получен вердикт: правила (бесплатно) / ИИ / ручная правка оператора. */
  verdictSource?: VerdictSource | null
  /** Вердикт детерминированной эвристики — для строки расхождения «правила → ИИ». */
  heuristicCategory?: string | null
  /** Кто и когда переписал вердикт вручную (источник `operator`). */
  editedBy?: string | null
  editedAt?: string | null
  /** `parsed.issue_intent` — почему заявка ушла из пробеговой лестницы. */
  issueIntent?: string | null
  /** `warnings` строки разбора — чему в ней нельзя доверять (см. RowWarningChips). */
  warnings?: string[] | null
  /** Начало и конец окна телеметрии (ISO). Разные даты → окно длиннее суток. */
  windowFrom?: string | null
  windowTo?: string | null
}

/**
 * Цвет ТЕКСТА вердикта — один источник для таблицы разбора и пилюли телеметрии.
 * Заливка занята статусами Okdesk, дублировать её нельзя (см. VerdictPill).
 */
export const VERDICT_TEXT_STYLE: Record<string, string> = {
  'Глушение': 'text-warning',
  'Данные верны': 'text-success',
  'Не было питания': 'text-orange',
  'Терминал подключился': 'text-info',
  'Объект не найден': 'text-red-400',
  'Нет данных': 'text-muted',
  'Нет номера/даты': 'text-muted',
  // Номер нашли, а даты неисправности нет — родня «Нет номера/даты», тот же цвет.
  'Нет даты': 'text-muted',
  'Номер не распознан': 'text-warning',
  'Ошибка данных': 'text-orange',
  'Проверить': 'text-info',
  // Служебные вердикты «заявка не о пробеге» — своя, спокойная зелень текста:
  // они не диагноз по треку, а маршрутизация, и не должны читаться как «Глушение»
  // или «Ошибка данных» (см. SERVICE_VERDICTS).
  'Не заявка о расхождении пробега': 'text-secondary',
  'Ложный пробег / экранирование': 'text-secondary',
}

/**
 * СЛУЖЕБНЫЕ вердикты: строку по ним нельзя ни показать клиенту как ответ, ни
 * предложить автоответом. Два вида:
 *   • разбор не состоялся (нет номера/даты, ошибка данных) — отвечать нечем;
 *   • заявка вообще не о расхождении пробега (работы с прибором, просьба
 *     обнулить ложный пробег) — отвечает не пробеговый шаблон, а оператор.
 * Телеметрия у второй группы СОБРАНА и остаётся на экране как справка.
 */
export const SERVICE_VERDICTS = new Set([
  'Нет номера/даты',
  'Нет даты',
  'Номер не распознан',
  'Ошибка данных',
  'Не заявка о расхождении пробега',
  'Ложный пробег / экранирование',
])

/** Вердикты «заявка не о пробеге» — телеметрия есть, но это справка, а не диагноз. */
export const NON_MILEAGE_VERDICTS = new Set([
  'Не заявка о расхождении пробега',
  'Ложный пробег / экранирование',
])

/** Подсказка к бейджу «служебный» рядом с вердиктом строки. */
export const NON_MILEAGE_HINT =
  'Заявка не о расхождении пробега — автоответ по пробеговому шаблону тут не годится. '
  + 'Телеметрия ниже собрана как справка: смотрите, но клиенту отвечает оператор'

export function isServiceVerdict(verdict?: string | null): boolean {
  return !!verdict && SERVICE_VERDICTS.has(verdict)
}

export function isNonMileageVerdict(verdict?: string | null): boolean {
  return !!verdict && NON_MILEAGE_VERDICTS.has(verdict)
}

/** Старые кэши источника не несут — вердикт в них посчитан правилами. */
export function normalizeVerdictSource(src?: VerdictSource | string | null): VerdictSource {
  return src === 'ai' || src === 'operator' ? src : 'rules'
}

/** Подсказка «откуда вердикт» — одна формулировка на всё приложение. */
export function verdictSourceHint(src: VerdictSource): string {
  if (src === 'ai') return 'Вердикт ИИ (DeepSeek) — есть обоснование, уверенность и черновик ответа'
  if (src === 'operator') return 'Вердикт исправлен вручную оператором. ИИ ручную правку не перезаписывает'
  return 'Предварительный вердикт по правилам — посчитан бесплатно, DeepSeek ещё не вызывали'
}

/**
 * Пилюля вердикта. Источник читается ФОРМОЙ РАМКИ и глифом (макет
 * .figma-shots/card-v4-variants.html, класс .pill-src):
 *   правила  — пунктирная нейтральная рамка + хвост-подпись «по правилам»;
 *   ИИ       — сплошная рамка в цвет вердикта + ✦;
 *   оператор — сплошная нейтральная рамка + ✎.
 * Цвет самого вердикта во всех трёх случаях один и тот же (VERDICT_TEXT_STYLE),
 * новых цветов не заводим — иначе пилюля спорит со статусами Okdesk.
 */
export function VerdictPill({ verdict, source, className = '', title }: {
  verdict: string | null
  source?: VerdictSource | null
  className?: string
  title?: string
}) {
  const src = normalizeVerdictSource(source)
  const color = (verdict && VERDICT_TEXT_STYLE[verdict]) || 'text-white'
  const border = src === 'rules'
    ? 'border border-dashed border-border'
    : src === 'ai'
    ? 'border border-solid border-current'
    : 'border border-solid border-border'
  const glyph = src === 'ai' ? '✦ ' : src === 'operator' ? '✎ ' : ''
  const tail = src === 'rules' ? 'по правилам' : src === 'ai' ? 'ИИ' : 'оператор'
  return (
    <span
      title={title ?? verdictSourceHint(src)}
      className={`inline-flex max-w-full min-w-0 items-center gap-[5px] rounded-pill bg-frame px-[9px] py-0.5 align-middle text-[11px] font-medium leading-4 ${border} ${color} ${className}`}
    >
      <span className="min-w-0 truncate">{glyph}{verdict ?? 'Без вердикта'}</span>
      <span className="shrink-0 text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">{tail}</span>
    </span>
  )
}

/**
 * Ярлык «про что заявка на самом деле» (`parsed.issue_intent`): установка,
 * замена, отключение, подключение, перемещение прибора или просьба обнулить
 * ложный пробег. Оператору важно видеть ПРИЧИНУ, а не только «не о пробеге».
 *
 * Форма плоская, как у пилюли вердикта, но нейтральная: это не диагноз, спорить
 * цветом со статусами и вердиктами ярлык не должен. Пусто — ничего не рисуем.
 */
export function IssueIntentChip({ intent, className = '' }: {
  intent?: string | null
  className?: string
}) {
  if (!intent) return null
  return (
    <span
      title={`Заявка распознана как «${intent}» — поэтому она вышла из лестницы вердиктов о расхождении пробега`}
      className={`inline-flex max-w-full min-w-0 items-center gap-[5px] rounded-pill border border-border bg-frame px-[9px] py-0.5 align-middle text-[11px] leading-4 text-secondary ${className}`}
    >
      <span className="shrink-0 text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">заявка про</span>
      <span className="min-w-0 truncate">{intent}</span>
    </span>
  )
}

/**
 * ЧЕМУ В СТРОКЕ НЕЛЬЗЯ ДОВЕРЯТЬ (`warnings` строки разбора). Причинный вердикт
 * при непустом списке бэкенд уже разворачивает в «Проверить» — здесь оператор
 * видит ПРИЧИНУ, иначе «Проверить» выглядит как случайная осторожность.
 * Короткий ярлык — на экране, полная расшифровка — в подсказке при наведении.
 */
const WARNING_LABELS: Record<string, string> = {
  region_conflict: 'регион не совпал',
  act_numbers_differ: 'пробеги в акте расходятся',
  two_dates_one_plate: 'две даты',
}

const WARNING_HINTS: Record<string, string> = {
  region_conflict: 'Регион в заявке не совпадает с регионом найденного объекта — '
    + 'возможно, это другая машина. Сверьте гос.номер с письмом',
  act_numbers_differ: 'В акте текст и таблица дают разные пробеги — сверьте с документом',
  two_dates_one_plate: 'У этого ТС в заявке две разные даты из разных документов — '
    + 'строки не сведены, проверьте, к какому дню относится жалоба',
}

/** Список открытый: неизвестное значение показываем как есть, интерфейс не ломаем. */
function warningLabel(w: string): string {
  return WARNING_LABELS[w] ?? w
}

function warningHint(w: string): string {
  return WARNING_HINTS[w]
    ?? `Разбор пометил строку как ненадёжную («${w}») — проверьте данные по документу`
}

/** Мусор из старых кэшей (пустые строки, дубли, не-строки) до экрана не доходит. */
function normalizeWarnings(warnings?: string[] | null): string[] {
  if (!Array.isArray(warnings)) return []
  const out: string[] = []
  for (const w of warnings) {
    if (typeof w !== 'string') continue
    const v = w.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * Пометки «чему нельзя доверять» рядом с вердиктом строки. Форма — как у бейджа
 * «не о пробеге», но цвет предупреждающий: это не маршрутизация, а сомнение в
 * самих данных. Пустой/отсутствующий массив — ничего не рисуем.
 */
export function RowWarningChips({ warnings, className = '' }: {
  warnings?: string[] | null
  className?: string
}) {
  const list = normalizeWarnings(warnings)
  if (list.length === 0) return null
  return (
    <>
      {list.map(w => (
        <span
          key={w}
          title={warningHint(w)}
          className={`inline-flex items-center gap-1 rounded-pill border border-warning/40 bg-warning/10 px-1.5 py-0.5 align-middle text-[9px] font-medium leading-3 text-warning ${className}`}
        >
          <AlertTriangle size={9} className="shrink-0" />
          {warningLabel(w)}
        </span>
      ))}
    </>
  )
}

/** Расшифровки всех пометок строки одной спокойной строкой (для блока телеметрии). */
function warningsNote(warnings?: string[] | null): string | null {
  const list = normalizeWarnings(warnings)
  if (list.length === 0) return null
  return list.map(warningHint).join('. ')
}

/**
 * Длина окна телеметрии в сутках по двум ISO-датам (`YYYY-MM-DD`), включительно.
 * Отдельного поля бэкенд не отдаёт — считаем сами. `null` значит «показывать
 * нечего»: конца окна нет, он равен началу или даты не разобрались.
 */
function telemetryWindowDays(from?: string | null, to?: string | null): number | null {
  if (!from || !to || from === to) return null
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null
  return Math.round((b - a) / 86_400_000) + 1
}

/**
 * Почему длинное окно опасно. Пороги телеметрии (телепорты, доля низких
 * спутников, число пакетов) откалиброваны НА СУТКИ и намеренно не меняются
 * (решение владельца проекта), поэтому по многомесячному окну метрики
 * накопленные, а вердикт по ним — не диагноз.
 */
export const TELEMETRY_WINDOW_HINT =
  'Метрики и флаги посчитаны за ВЕСЬ период, а не за один день: телепорты, доля '
  + 'низких спутников и число пакетов — накопленные. Пороги вердикта откалиброваны '
  + 'на сутки, поэтому по такому окну вердикту доверять нельзя — смотрите трек'

/** Ярлык «период N суток» рядом с телеметрией. `null`/1 сутки — ничего не рисуем. */
export function TelemetryWindowChip({ days, className = '' }: {
  days?: number | null
  className?: string
}) {
  if (days == null) return null
  return (
    <span
      title={TELEMETRY_WINDOW_HINT}
      className={`inline-flex items-center gap-1 rounded-pill border border-warning/40 bg-warning/10 px-[9px] py-0.5 align-middle text-[11px] leading-4 text-warning ${className}`}
    >
      <AlertTriangle size={10} className="shrink-0" />
      период {days} суток
    </span>
  )
}

/**
 * Правила и действующий вердикт разошлись — это надо показать, а не спрятать.
 * У источника «правила» расхождения нет по определению: сравнивать не с чем.
 */
export function verdictDisagreement(
  verdict: string | null | undefined,
  heuristic: string | null | undefined,
  source?: VerdictSource | null,
): { from: string; to: string; by: string } | null {
  const src = normalizeVerdictSource(source)
  if (src === 'rules' || !heuristic || !verdict || heuristic === verdict) return null
  return { from: heuristic, to: verdict, by: src === 'ai' ? 'ИИ' : 'оператор' }
}

/** Строка расхождения — печатается прямо, без наведения мыши. */
export function VerdictDisagreeLine({ verdict, heuristic, source, className = '' }: {
  verdict: string | null | undefined
  heuristic: string | null | undefined
  source?: VerdictSource | null
  className?: string
}) {
  const d = verdictDisagreement(verdict, heuristic, source)
  if (!d) return null
  return (
    <p className={`text-[11px] leading-4 text-muted ${className}`}>
      ⇄ правила: <b className="font-medium text-secondary">{d.from}</b> → {d.by}:{' '}
      <b className="font-medium text-secondary">{d.to}</b>
      {d.by === 'ИИ' ? ' — машина переспорила правила' : ' — ручную правку ИИ не перезаписывает'}
    </p>
  )
}

/**
 * Какие метрики обосновывают вердикт — они получают обводку и белое значение.
 * Категории вне словаря не подсвечивают ничего.
 */
const HIGHLIGHTED_METRICS: Record<string, string[]> = {
  'Глушение': ['gap', 'teleport', 'low_sat'],
  'Не было питания': ['power'],
  'Данные верны': [],
}

const FLAG_LABELS: Record<string, string> = {
  jamming_suspect: 'подозрение на глушение',
  low_satellites: 'мало спутников',
  track_gap: 'обрыв трека',
  power_off: 'нет питания',
  no_data: 'нет данных',
  object_not_found: 'объект не найден',
  zero_coords: 'нулевые координаты',
  speed_spike: 'выбросы скорости',
  teleport: 'телепорты трека',
  sparse_data: 'почти нет связи',
}

/** Расшифровка флага при наведении — там, где короткой подписи мало. */
const FLAG_HINTS: Record<string, string> = {
  sparse_data: 'Терминал почти не выходил на связь за сутки — вероятна неисправность или демонтаж прибора',
}

/** Минуты → «2 ч 15 мин» от часа и больше, иначе «45 мин». */
function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} мин`
  const hours = Math.floor(min / 60)
  const rest = Math.round(min % 60)
  return rest > 0 ? `${hours} ч ${rest} мин` : `${hours} ч`
}

function formatVolts(v: number): string {
  return v.toFixed(1).replace('.', ',')
}

interface Metric {
  key: string
  label: string
  value: string | null
  warn?: boolean
}

function buildMetrics(t: AutomationTelemetry): Metric[] {
  return [
    { key: 'gap', label: 'Обрыв трека', value: t.max_gap_min != null ? formatMinutes(t.max_gap_min) : null },
    { key: 'teleport', label: 'Телепорты', value: String(t.teleport_jumps) },
    { key: 'low_sat', label: 'Спутников < 4', value: t.low_sat_ratio != null ? `${Math.round(t.low_sat_ratio * 100)}%` : null },
    {
      key: 'power',
      label: 'Питание',
      value: t.min_power_v != null
        ? `${formatVolts(t.min_power_v)} В — ${t.min_power_v < 11 ? 'просадка' : 'норма'}`
        : null,
      warn: t.min_power_v != null && t.min_power_v < 11,
    },
    { key: 'packets', label: 'Пакетов', value: String(t.packets) },
    { key: 'max_speed', label: 'Макс. скорость', value: t.max_speed != null ? `${t.max_speed} км/ч` : null },
    { key: 'move_time', label: 'В движении', value: t.move_time_min != null ? formatMinutes(Math.round(t.move_time_min)) : null },
    { key: 'spikes', label: 'Выбросы скорости', value: String(t.speed_spike_count) },
    {
      key: 'implied',
      label: 'Расчётная скорость',
      value: t.max_implied_kmh != null && t.max_implied_kmh > 0 ? `${Math.round(t.max_implied_kmh)} км/ч` : null,
    },
  ]
}

export function TelemetryPanel({
  telemetry,
  category,
  confidence,
  needsReview,
  autoEligible = false,
  subtitle = null,
  reasoning = null,
  verdictSource = null,
  heuristicCategory = null,
  editedBy = null,
  editedAt = null,
  issueIntent = null,
  warnings = null,
  windowFrom = null,
  windowTo = null,
}: TelemetryPanelProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  // Чему в строке нельзя доверять и за какой период собраны метрики — оба
  // ограничения касаются вердикта выше, поэтому считаем их до отрисовки шапки.
  const warnNote = warningsNote(warnings)
  const windowDays = telemetryWindowDays(windowFrom, windowTo)
  const src = normalizeVerdictSource(verdictSource)
  // Уверенность и полоса доверия существуют ТОЛЬКО у вердикта ИИ: у правил и у
  // человека их просто нет, а чужая уверенность от прошлого прогона врала бы.
  const percent = src === 'ai' && confidence != null ? Math.round(confidence * 100) : null

  let verdictNote = ''
  if (src === 'rules') {
    verdictNote = 'предварительно — ИИ ещё не вызывался'
  } else if (src === 'operator') {
    // Без имени и времени пилюля «✎ оператор» не даёт понять, стоит ли ей верить:
    // правка могла быть неделю назад и по старым данным.
    verdictNote = ['исправлено вручную', editedBy, editedAt].filter(Boolean).join(' · ')
  } else if (percent != null) {
    verdictNote = `Уверенность ${percent}%`
    if (autoEligible) verdictNote += ' — авто-ответ доступен'
    else if (needsReview) verdictNote += ' — нужна проверка'
  }

  const highlighted = new Set(category ? HIGHLIGHTED_METRICS[category] ?? [] : [])
  const metrics = telemetry ? buildMetrics(telemetry).filter(m => m.value != null) : []

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictPill verdict={category} source={src} />
          <IssueIntentChip intent={issueIntent} />
          {/* Пометки строки — сразу за вердиктом: они объясняют, почему он «Проверить». */}
          <RowWarningChips warnings={warnings} />
          <TelemetryWindowChip days={windowDays} />
          {verdictNote && <span className="text-[13px] text-secondary">{verdictNote}</span>}
          {subtitle && <span className="ml-auto text-[13px] text-muted">{subtitle}</span>}
        </div>
        {/* Вердикт служебный: метрики ниже — справка, а не основание для ответа. */}
        {isNonMileageVerdict(category) && (
          <p className="text-[11px] leading-4 text-muted">{NON_MILEAGE_HINT}</p>
        )}
        {/* Расшифровка пометок прямым текстом: ярлыки короткие, а решение по строке
            оператор принимает здесь же — заставлять его наводить мышь не годится. */}
        {warnNote && (
          <p className="text-[11px] leading-4 text-warning">{warnNote}</p>
        )}
        {percent != null && (
          <div className="h-1 w-full rounded-pill bg-frame overflow-hidden">
            <div className="h-full rounded-pill bg-accent" style={{ width: `${percent}%` }} />
          </div>
        )}
        {/* Расхождение правил с действующим вердиктом — прямым текстом, не в тултипе. */}
        <VerdictDisagreeLine verdict={category} heuristic={heuristicCategory} source={src} />
      </div>

      {telemetry == null ? (
        <div className="text-[13px] text-muted">Телеметрия не загружена</div>
      ) : (
        <>
          {/* Окно длиннее суток: метрики ниже накопленные. Пороги остались
              суточными намеренно — предупреждаем, а не подкручиваем их. */}
          {windowDays != null && (
            <p className="text-[11px] leading-4 text-muted">
              Окно телеметрии — {windowDays} суток ({windowFrom} — {windowTo}). {TELEMETRY_WINDOW_HINT}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {metrics.map(m => {
              const isKey = highlighted.has(m.key)
              // Прозрачная обводка у неподсвеченных — чтобы карточки не «прыгали» по размеру.
              const border = isKey ? 'border border-accent' : 'border border-transparent'
              const valueColor = m.warn ? 'text-warning' : isKey ? 'text-white' : 'text-secondary'
              return (
                <div key={m.key} className={`bg-frame rounded-md p-3 ${border}`}>
                  <div className="text-[11px] text-muted">{m.label}</div>
                  <div className={`text-[14px] ${valueColor} ${isKey ? 'font-bold' : ''}`}>{m.value}</div>
                </div>
              )
            })}
          </div>

          {telemetry.flags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {telemetry.flags.map(f => (
                <span
                  key={f}
                  title={FLAG_HINTS[f]}
                  className="px-2 py-0.5 rounded-pill border border-border text-[11px] text-secondary"
                >
                  {FLAG_LABELS[f] ?? f}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* Обоснование вердикта — вне ветки телеметрии: ИИ может объяснить вердикт
          и когда метрик нет (объект не найден, нет данных за день).
          Заголовок вынесен из абзаца: line-clamp переключает display на
          -webkit-box и сломал бы flex на том же элементе. */}
      {reasoning && (
        <div className="min-w-0 text-[11px] text-muted leading-relaxed">
          <div className="flex items-center gap-1.5 font-medium text-accent">
            <Sparkles size={12} className="shrink-0" />
            <span>Почему такой вердикт</span>
          </div>
          <p className={`mt-0.5 ${reasoningOpen ? '' : 'line-clamp-2'}`}>{reasoning}</p>
          <button
            onClick={() => setReasoningOpen(v => !v)}
            className="mt-0.5 text-accent hover:underline"
          >
            {reasoningOpen ? 'Свернуть' : 'Подробнее'}
          </button>
        </div>
      )}
    </div>
  )
}
