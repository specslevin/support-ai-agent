/** Статусы, при которых заявка считается закрытой — срок не подсвечиваем */
const CLOSED_STATUSES = new Set(['completed', 'inst_fin', 'closed'])

export type DeadlineUrgency = 'overdue' | 'soon' | 'near' | 'ok' | 'none'

export interface DeadlineInfo {
  urgency: DeadlineUrgency
  /** Человекочитаемый текст: «просрочено», «осталось 5 ч», «2 дн», «DD.MM.YYYY» */
  label: string
  /** CSS-классы Tailwind для текста и иконки */
  textClass: string
}

const H = 3_600_000 // ms в 1 часе
const D = 86_400_000 // ms в 1 сутках

/** Форматирует оставшееся/прошедшее время в лаконичный текст */
function formatRemaining(diffMs: number): string {
  const abs = Math.abs(diffMs)
  if (abs < H) {
    const m = Math.round(abs / 60_000)
    return `${m} мин`
  }
  if (abs < D) {
    const h = Math.round(abs / H)
    return `${h} ч`
  }
  const d = Math.round(abs / D)
  return `${d} дн`
}

/**
 * Вычисляет срочность и отображаемый текст дедлайна.
 * @param deadlineAt  ISO-строка или null
 * @param status      Текущий статус заявки
 */
export function getDeadlineInfo(deadlineAt: string | null, status: string | null): DeadlineInfo {
  // Нет дедлайна
  if (!deadlineAt) {
    return { urgency: 'none', label: '', textClass: '' }
  }

  const deadline = new Date(deadlineAt)
  if (isNaN(deadline.getTime())) {
    return { urgency: 'none', label: '', textClass: '' }
  }

  // Заявка закрыта — показываем нейтрально
  if (CLOSED_STATUSES.has(status ?? '')) {
    const dateStr = deadline.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
    return { urgency: 'ok', label: dateStr, textClass: 'text-muted' }
  }

  const now = Date.now()
  const diffMs = deadline.getTime() - now

  if (diffMs < 0) {
    // Просрочено
    return {
      urgency: 'overdue',
      label: `просрочено ${formatRemaining(diffMs)} назад`,
      textClass: 'text-red-400',
    }
  }

  if (diffMs < D) {
    // Меньше 24 ч
    return {
      urgency: 'soon',
      label: `осталось ${formatRemaining(diffMs)}`,
      textClass: 'text-amber-400',
    }
  }

  if (diffMs < 3 * D) {
    // Меньше 3 суток
    return {
      urgency: 'near',
      label: `осталось ${formatRemaining(diffMs)}`,
      textClass: 'text-yellow-300',
    }
  }

  // Всё в норме — показываем дату
  const dateStr = deadline.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  return {
    urgency: 'ok',
    label: dateStr,
    textClass: 'text-muted',
  }
}
