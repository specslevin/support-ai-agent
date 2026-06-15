import { useIssuesStore } from '../store/issuesStore'
import { EMPLOYEES } from '../store/userStore'

const STATUSES = [
  { value: '', label: 'Все статусы' },
  { value: 'opened', label: 'Открыта' },
  { value: 'wait', label: 'В работе' },
  { value: 'delayed', label: 'Ожидание ответа' },
  { value: 'completed', label: 'Решена' },
  { value: 'inst_fin', label: 'Завершена' },
  { value: 'closed', label: 'Закрыта' },
]

export function IssueFilters() {
  const { status, company, search, assignee, issueId, setFilter, resetFilters } = useIssuesStore()
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
    </div>
  )
}
