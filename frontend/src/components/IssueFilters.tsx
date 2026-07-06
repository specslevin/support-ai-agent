import { useIssuesStore } from '../store/issuesStore'
import { EMPLOYEES } from '../store/userStore'
import { SavedFilters } from './SavedFilters'
import type { ViewMode } from './IssuesList'

const STATUSES = [
  { value: '', label: 'Все статусы' },
  { value: 'opened', label: 'Открыта' },
  { value: 'wait', label: 'В работе' },
  { value: 'delayed', label: 'Ожидание ответа' },
  { value: 'completed', label: 'Решена' },
  { value: 'inst_fin', label: 'Завершена' },
  { value: 'closed', label: 'Закрыта' },
]

interface IssueFiltersProps {
  viewMode: ViewMode
  onViewModeChange: (m: ViewMode) => void
}

export function IssueFilters({ viewMode, onViewModeChange }: IssueFiltersProps) {
  const { status, company, search, assignee, issueId, sort, order, setFilter, setSort, resetFilters } = useIssuesStore()
  const hasAny = status || company || search || assignee || issueId

  const inputCls = 'bg-surface border border-border rounded px-3 py-1.5 text-sm text-white placeholder-muted focus:outline-none focus:border-accent'

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input
        type="text"
        inputMode="numeric"
        placeholder="№ заявки"
        value={issueId}
        onChange={e => setFilter('issueId', e.target.value.replace(/\D/g, ''))}
        className={`${inputCls} w-28`}
      />

      <input
        type="text"
        placeholder="Поиск по теме..."
        value={search}
        onChange={e => setFilter('search', e.target.value)}
        className={`${inputCls} w-48`}
      />

      <select
        value={status}
        onChange={e => setFilter('status', e.target.value)}
        className={inputCls}
      >
        {STATUSES.map(s => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>

      <select
        value={assignee}
        onChange={e => setFilter('assignee', e.target.value)}
        className={inputCls}
      >
        <option value="">Все ответственные</option>
        <option value="__none__">Не назначен</option>
        {EMPLOYEES.map(e => (
          <option key={e.id} value={e.name}>{e.name}</option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Компания..."
        value={company}
        onChange={e => setFilter('company', e.target.value)}
        className={`${inputCls} w-40`}
      />

      {hasAny && (
        <button
          onClick={resetFilters}
          className="text-xs text-muted hover:text-white px-2 py-1.5 transition-colors"
        >
          Сбросить
        </button>
      )}

      <SavedFilters />

      {/* Сортировка списка — рядом с переключателем вида */}
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <span className="text-xs text-muted">Сортировка:</span>
        <select
          value={`${sort}:${order}`}
          onChange={e => {
            const [s, o] = e.target.value.split(':') as [string, 'asc' | 'desc']
            setSort(s, o)
          }}
          className={`${inputCls} cursor-pointer`}
        >
          <option value="deadline_at:asc">По сроку ↑</option>
          <option value="deadline_at:desc">По сроку ↓</option>
          <option value="created_at:desc">По дате создания ↓</option>
          <option value="created_at:asc">По дате создания ↑</option>
          <option value="updated_at:desc">По дате изменения ↓</option>
          <option value="updated_at:asc">По дате изменения ↑</option>
        </select>
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-0.5 p-0.5 rounded-lg border border-border bg-base shrink-0">
        <button
          onClick={() => onViewModeChange('table')}
          title="Таблица"
          className={`flex items-center justify-center p-1.5 rounded transition-colors ${
            viewMode === 'table'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-muted hover:text-white'
          }`}
        >
          <ListIcon />
        </button>
        <button
          onClick={() => onViewModeChange('cards')}
          title="Карточки"
          className={`flex items-center justify-center p-1.5 rounded transition-colors ${
            viewMode === 'cards'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-muted hover:text-white'
          }`}
        >
          <LayoutGridIcon />
        </button>
      </div>
    </div>
  )
}

// Inline icon helpers to avoid adding lucide import dependency here
// (IssuesList already imports these from lucide-react)
function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

function LayoutGridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
    </svg>
  )
}
