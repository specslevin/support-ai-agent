// Colors match Okdesk UI palette
const STYLES: Record<string, { bg: string; text: string; label: string }> = {
  opened:    { bg: '#0ea5e9', text: '#fff',     label: 'Открыта' },
  wait:      { bg: '#a855f7', text: '#fff',     label: 'Ожидание' },
  delayed:   { bg: '#f97316', text: '#fff',     label: 'Отложена' },
  completed: { bg: '#22c55e', text: '#fff',     label: 'Решена' },
  inst_fin:  { bg: '#22c55e', text: '#fff',     label: 'Завершена' },
  closed:    { bg: '#4b5563', text: '#d1d5db',  label: 'Закрыта' },
}

const DEFAULT = { bg: '#374151', text: '#9ca3af', label: '' }

export function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? ''
  const { bg, text, label } = STYLES[s] ?? DEFAULT
  return (
    <span
      style={{ backgroundColor: bg, color: text }}
      className="inline-block text-xs px-2.5 py-0.5 rounded font-medium whitespace-nowrap"
    >
      {label || s || '—'}
    </span>
  )
}
