// Colors taken directly from Okdesk API status.color field
const STYLES: Record<string, { color: string; label: string }> = {
  opened:    { color: '#3edad8', label: 'Открыта' },
  wait:      { color: '#2b6684', label: 'В работе' },
  delayed:   { color: '#bb7db2', label: 'Ожидание ответа' },
  completed: { color: '#67a030', label: 'Решена' },
  inst_fin:  { color: '#67a030', label: 'Завершена' },
  closed:    { color: '#787880', label: 'Закрыта' },
}

export function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? ''
  const style = STYLES[s]
  if (!style) {
    return (
      <span className="inline-block text-xs px-2.5 py-0.5 rounded font-medium bg-gray-700 text-gray-300 whitespace-nowrap">
        {s || '—'}
      </span>
    )
  }
  return (
    <span
      style={{ backgroundColor: style.color, color: '#fff' }}
      className="inline-block text-xs px-2.5 py-0.5 rounded font-medium whitespace-nowrap"
    >
      {style.label}
    </span>
  )
}
