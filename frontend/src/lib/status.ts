// Единый источник цветов и подписей статусов Okdesk.
// Цвета — это status.color из Okdesk API, дублировать их по компонентам нельзя:
// раньше один и тот же статус красился по-разному (wait был и #2b6684, и #2bb3c0).
// Те же значения лежат в tailwind.config.js (colors.status.*) и в Figma-переменных
// коллекции support-ai-agent (status/opened … status/closed).

export const STATUS_COLOR: Record<string, string> = {
  opened: '#3EDAD8',
  wait: '#2B6684',
  delayed: '#BB7DB2',
  no_time: '#F68741',
  completed: '#67A030',
  inst_fin: '#67A030',
  closed: '#787880',
}

/**
 * Цвет текста на ЗАЛИТОЙ статусом пилюле. Белый везде — решение по внешнему виду:
 * пробовали чёрный на светлых статусах (opened/delayed/completed) ради контраста
 * AA, выглядело хуже. Оставляем белый, как было исторически.
 *
 * Внимание: обычная пилюля статуса больше не заливается (см. statusPillStyle —
 * тёмный фон + обводка + осветлённый текст). Эта карта нужна только там, где
 * заливка цветом статуса остаётся осознанным решением.
 */
export const STATUS_TEXT: Record<string, string> = {
  opened: '#FFFFFF',
  wait: '#FFFFFF',
  delayed: '#FFFFFF',
  no_time: '#FFFFFF',
  completed: '#FFFFFF',
  inst_fin: '#FFFFFF',
  closed: '#FFFFFF',
}

/** Подписи статусов в интерфейсе (как их называет оператор). */
export const STATUS_LABEL: Record<string, string> = {
  opened: 'Открыта',
  wait: 'В работе',
  delayed: 'Ожидание ответа',
  no_time: 'Отложена',
  completed: 'Решена',
  inst_fin: 'Завершена',
  closed: 'Закрыта',
}

/** Фон пилюли статуса — тёмная подложка (Background/Frame карточек и таблиц). */
export const STATUS_PILL_BG = '#171717'

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

function parseHex(hex: string): [number, number, number] | null {
  const m = HEX_RE.exec(hex.trim())
  if (!m) return null
  let body = m[1]
  if (body.length === 3) body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ]
}

function toHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

/** Относительная яркость по WCAG 2.1: sRGB → линейное пространство → взвешенная сумма. */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Коэффициент контраста двух цветов по WCAG: от 1:1 до 21:1. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Порог AA для мелкого текста (пилюли, подписи) — 4.5:1. */
const AA_SMALL_TEXT = 4.5
/** Смешиваем с белым шагами по 8%; 40 шагов гарантированно доводят до чистого белого. */
const MIX_STEP = 0.08
const MAX_STEPS = 40

/**
 * Цвет статуса, пригодный как ЦВЕТ ТЕКСТА на тёмном фоне.
 *
 * Зачем: цвета статусов приходят из Okdesk API (status.color) и подбирались под
 * светлую тему с заливкой. Часть из них — тёмные (например wait = #2B6684), и текст
 * такого цвета на подложке #171717 практически не читается. Поэтому цвет
 * осветляется в направлении белого до контраста 4.5:1 — это порог WCAG AA для
 * мелкого текста, а подписи статусов у нас как раз мелкие (text-xs).
 *
 * Функция чистая: тот же вход → тот же выход, никакого DOM.
 */
export function statusTextColor(hex: string, background: string = STATUS_PILL_BG): string {
  const rgb = parseHex(hex)
  if (!rgb) return '#FFFFFF'
  const bg = parseHex(background) ?? [23, 23, 23]

  let current = rgb
  for (let i = 0; i < MAX_STEPS; i++) {
    if (contrast(current, bg) >= AA_SMALL_TEXT) break
    const t = Math.min(1, (i + 1) * MIX_STEP)
    current = [
      rgb[0] + (255 - rgb[0]) * t,
      rgb[1] + (255 - rgb[1]) * t,
      rgb[2] + (255 - rgb[2]) * t,
    ]
  }
  return toHex(current)
}

/**
 * Стиль пилюли статуса: тёмный фон, обводка ИСХОДНЫМ цветом статуса из API
 * (он остаётся узнаваемым как графический акцент) и осветлённый текст того же
 * цвета — чтобы подпись читалась. Утверждённый вид карточки/списка.
 */
export function statusPillStyle(status: string): {
  backgroundColor: string
  borderColor: string
  color: string
} {
  const base = STATUS_COLOR[status] ?? '#404040'
  return {
    backgroundColor: STATUS_PILL_BG,
    borderColor: base,
    color: statusTextColor(base),
  }
}
