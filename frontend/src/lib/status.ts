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
 * Цвет текста на залитой статусом пилюле. Белый везде — решение по внешнему виду:
 * пробовали чёрный на светлых статусах (opened/delayed/completed) ради контраста
 * AA, выглядело хуже. Оставляем белый, как было исторически.
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

/** Стиль залитой пилюли статуса: фон + контрастный текст. */
export function statusPillStyle(status: string): { backgroundColor: string; color: string } {
  return {
    backgroundColor: STATUS_COLOR[status] ?? '#404040',
    color: STATUS_TEXT[status] ?? '#FFFFFF',
  }
}
