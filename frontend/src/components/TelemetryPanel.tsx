import { useState } from 'react'
import { Lightbulb } from 'lucide-react'
import type { AutomationTelemetry } from '../types'

interface TelemetryPanelProps {
  telemetry: AutomationTelemetry | null
  category: string | null           // вердикт: «Глушение», «Данные верны», …
  confidence: number | null         // 0..1
  needsReview: boolean
  autoEligible?: boolean            // можно отправлять авто-ответ
  subtitle?: string | null          // подпись справа в шапке, например «Е456КХ163 · 21.07.2026»
  reasoning?: string | null         // обоснование вердикта от ИИ — под метриками
}

const CATEGORY_PILL: Record<string, string> = {
  'Глушение': 'bg-warning text-black',
  'Данные верны': 'bg-success text-black',
  'Не было питания': 'bg-orange text-black',
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
}: TelemetryPanelProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const pillClass = (category && CATEGORY_PILL[category]) || 'bg-frame text-secondary'
  const percent = confidence != null ? Math.round(confidence * 100) : null

  let verdictNote = ''
  if (percent != null) {
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
          <span className={`px-2.5 py-1 rounded-pill text-[13px] font-medium ${pillClass}`}>
            {category ?? 'Без вердикта'}
          </span>
          {verdictNote && <span className="text-[13px] text-secondary">{verdictNote}</span>}
          {subtitle && <span className="ml-auto text-[13px] text-muted">{subtitle}</span>}
        </div>
        {percent != null && (
          <div className="h-1 w-full rounded-pill bg-frame overflow-hidden">
            <div className="h-full rounded-pill bg-accent" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>

      {telemetry == null ? (
        <div className="text-[13px] text-muted">Телеметрия не загружена</div>
      ) : (
        <>
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
                <span key={f} className="px-2 py-0.5 rounded-pill border border-border text-[11px] text-secondary">
                  {FLAG_LABELS[f] ?? f}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* Обоснование вердикта — вне ветки телеметрии: ИИ может объяснить вердикт
          и когда метрик нет (объект не найден, нет данных за день).
          Иконка вынесена из абзаца: line-clamp переключает display на
          -webkit-box и сломал бы flex на том же элементе. */}
      {reasoning && (
        <div className="flex items-start gap-1.5 text-[11px] text-muted leading-relaxed">
          <Lightbulb size={13} className="shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className={reasoningOpen ? '' : 'line-clamp-2'}>{reasoning}</p>
            <button
              onClick={() => setReasoningOpen(v => !v)}
              className="mt-0.5 text-accent hover:underline"
            >
              {reasoningOpen ? 'Свернуть' : 'Подробнее'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
