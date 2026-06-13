import { useIssuesStore } from '../store/issuesStore'

const STATUSES = [
  { value: '', label: 'Все статусы' },
  { value: 'opened', label: 'Открыта' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'resolved', label: 'Решена' },
  { value: 'closed', label: 'Закрыта' },
]

export function IssueFilters() {
  const { status, company, search, setFilter, resetFilters } = useIssuesStore()

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input
        type="text"
        placeholder="Поиск по теме..."
        value={search}
        onChange={e => setFilter('search', e.target.value)}
        className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-white placeholder-muted focus:outline-none focus:border-accent w-52"
      />

      <select
        value={status}
        onChange={e => setFilter('status', e.target.value)}
        className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-accent"
      >
        {STATUSES.map(s => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Компания..."
        value={company}
        onChange={e => setFilter('company', e.target.value)}
        className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-white placeholder-muted focus:outline-none focus:border-accent w-40"
      />

      {(status || company || search) && (
        <button
          onClick={resetFilters}
          className="text-xs text-muted hover:text-white px-2 py-1.5 transition-colors"
        >
          Сбросить
        </button>
      )}
    </div>
  )
}
