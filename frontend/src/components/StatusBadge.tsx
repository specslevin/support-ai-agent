const colors: Record<string, string> = {
  opened: 'bg-red-900/50 text-red-300 border border-red-700',
  in_progress: 'bg-yellow-900/50 text-yellow-300 border border-yellow-700',
  resolved: 'bg-green-900/50 text-green-300 border border-green-700',
  closed: 'bg-gray-800 text-gray-400 border border-gray-600',
}

const labels: Record<string, string> = {
  opened: 'Открыта',
  in_progress: 'В работе',
  resolved: 'Решена',
  closed: 'Закрыта',
}

export function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? 'unknown'
  const cls = colors[s] ?? 'bg-gray-800 text-gray-400 border border-gray-600'
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>
      {labels[s] ?? s}
    </span>
  )
}
