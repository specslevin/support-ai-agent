import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { StatusBadge } from './StatusBadge'
import type { Issue } from '../types'

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
    + ', '
    + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function IssueRow({ issue, selected, onClick }: { issue: Issue; selected: boolean; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-border cursor-pointer transition-colors text-sm ${
        selected ? 'bg-white/5' : 'hover:bg-white/[0.03]'
      }`}
    >
      <td className="px-3 py-2.5 text-xs font-mono text-muted w-24 whitespace-nowrap">
        {selected && <span className="text-accent mr-1">▶</span>}
        #{issue.external_id}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap w-44">
        {formatDate(issue.created_at)}
      </td>
      <td className="px-3 py-2.5 max-w-xs">
        <span className="line-clamp-1">{issue.subject ?? '—'}</span>
      </td>
      <td className="px-3 py-2.5 text-xs text-muted max-w-[200px]">
        <span className="line-clamp-1">{issue.company_name ?? '—'}</span>
      </td>
      <td className="px-3 py-2.5 text-xs text-muted max-w-[140px]">
        <span className="line-clamp-1">{issue.assignee_name ?? '—'}</span>
      </td>
      <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap w-44">
        {formatDate(issue.updated_at)}
      </td>
      <td className="px-3 py-2.5 w-32">
        <StatusBadge status={issue.status} />
      </td>
    </tr>
  )
}

export function IssuesList() {
  const { status, company, search, page, limit, selectedIssueId, setPage, setLimit, selectIssue } = useIssuesStore()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['issues', { status, company, search, page, limit }],
    queryFn: () => api.listIssues({
      status: status || undefined,
      company: company || undefined,
      search: search || undefined,
      page,
      limit,
    }),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  })

  if (isLoading && !data) {
    return <div className="flex items-center justify-center h-40 text-muted text-sm">Загрузка...</div>
  }
  if (isError) {
    return <div className="flex items-center justify-center h-40 text-red-400 text-sm">Ошибка загрузки</div>
  }

  const issues = data?.data ?? []
  const pagination = data?.pagination

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 bg-base z-10">
            <tr className="border-b border-border text-muted text-xs uppercase tracking-wider">
              <th className="px-3 py-2 font-medium">№ заявки</th>
              <th className="px-3 py-2 font-medium">Дата регистрации</th>
              <th className="px-3 py-2 font-medium">Тема</th>
              <th className="px-3 py-2 font-medium">Клиент</th>
              <th className="px-3 py-2 font-medium">Ответственный</th>
              <th className="px-3 py-2 font-medium">Дата изменения</th>
              <th className="px-3 py-2 font-medium">Статус</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue: Issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                selected={issue.id === selectedIssueId}
                onClick={() => selectIssue(issue.id === selectedIssueId ? null : issue.id)}
              />
            ))}
          </tbody>
        </table>

        {issues.length === 0 && (
          <div className="flex items-center justify-center h-32 text-muted text-sm">
            Заявок не найдено
          </div>
        )}
      </div>

      {pagination && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-xs text-muted shrink-0">
          <div className="flex items-center gap-3">
            <span>{(page - 1) * limit + 1}–{Math.min(page * limit, pagination.total)} из {pagination.total}</span>
            <div className="flex items-center gap-1.5">
              <span>Показывать:</span>
              {[20, 50, 100].map(n => (
                <button
                  key={n}
                  onClick={() => setLimit(n)}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    limit === n
                      ? 'bg-accent/20 text-accent border border-accent/40'
                      : 'border border-border hover:border-accent/60'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="px-2.5 py-1 rounded border border-border hover:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >←</button>
            <span className="px-3">{page} / {pagination.total_pages}</span>
            <button
              disabled={page >= pagination.total_pages}
              onClick={() => setPage(page + 1)}
              className="px-2.5 py-1 rounded border border-border hover:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >→</button>
          </div>
        </div>
      )}
    </div>
  )
}
