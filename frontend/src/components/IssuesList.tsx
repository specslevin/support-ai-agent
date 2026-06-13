import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { StatusBadge } from './StatusBadge'
import type { Issue } from '../types'

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function IssueRow({ issue, selected, onClick }: { issue: Issue; selected: boolean; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-border cursor-pointer transition-colors ${
        selected ? 'bg-accent/10' : 'hover:bg-surface'
      }`}
    >
      <td className="px-4 py-3 text-muted text-xs font-mono">#{issue.external_id}</td>
      <td className="px-4 py-3 text-sm max-w-xs truncate">{issue.subject ?? '—'}</td>
      <td className="px-4 py-3"><StatusBadge status={issue.status} /></td>
      <td className="px-4 py-3 text-xs text-muted truncate max-w-[160px]">{issue.company_name ?? '—'}</td>
      <td className="px-4 py-3 text-xs text-muted">{formatDate(issue.created_at)}</td>
    </tr>
  )
}

export function IssuesList() {
  const { status, company, search, page, limit, selectedIssueId, setPage, selectIssue } = useIssuesStore()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['issues', { status, company, search, page, limit }],
    queryFn: () => api.listIssues({ status: status || undefined, company: company || undefined, search: search || undefined, page, limit }),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 text-muted text-sm">
        Загрузка...
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-40 text-red-400 text-sm">
        Ошибка загрузки заявок
      </div>
    )
  }

  const issues = data?.data ?? []
  const pagination = data?.pagination

  return (
    <div className="flex flex-col h-full">
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="border-b border-border text-muted text-xs uppercase tracking-wider">
              <th className="px-4 py-2 font-medium">№</th>
              <th className="px-4 py-2 font-medium">Тема</th>
              <th className="px-4 py-2 font-medium">Статус</th>
              <th className="px-4 py-2 font-medium">Компания</th>
              <th className="px-4 py-2 font-medium">Дата</th>
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

      {pagination && pagination.total_pages > 1 && data && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border text-xs text-muted">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, pagination.total)} из {pagination.total}
          </span>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="px-2 py-1 rounded border border-border hover:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              ←
            </button>
            <span className="px-3 py-1">
              {page} / {pagination.total_pages}
            </span>
            <button
              disabled={page >= pagination.total_pages}
              onClick={() => setPage(page + 1)}
              className="px-2 py-1 rounded border border-border hover:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
