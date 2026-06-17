import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Check, X } from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { StatusBadge } from './StatusBadge'
import { TemplatePicker } from './IssueDetail'
import { EmployeeMenu, TypeMenu } from './pickers'
import type { Issue } from '../types'

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
    + ', '
    + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

const BULK_STATUSES = [
  { code: 'opened', label: 'Открыть' },
  { code: 'completed', label: 'Решить' },
  { code: 'closed', label: 'Закрыть' },
  { code: 'delayed', label: 'Ожидание' },
]

function Dropdown({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-border hover:border-accent text-white transition-colors"
      >
        {label} <ChevronDown size={13} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 bg-card border border-border rounded-lg py-1 min-w-[180px] max-h-72 overflow-y-auto shadow-lg">
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  )
}

function BulkActionBar() {
  const { checkedIds, clearChecked } = useIssuesStore()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const done = (label: string) => (res: { succeeded: number; failed: number }) => {
    queryClient.invalidateQueries({ queryKey: ['issues'] })
    setNotice(`${label}: успешно ${res.succeeded}${res.failed ? `, ошибок ${res.failed}` : ''}`)
    clearChecked()
    setComment('')
  }

  const assign = useMutation({ mutationFn: (id: number) => api.bulkAssign(checkedIds, id), onSuccess: done('Ответственный') })
  const setType = useMutation({ mutationFn: (code: string) => api.bulkType(checkedIds, code), onSuccess: done('Тип') })
  const setStatus = useMutation({
    mutationFn: (code: string) => {
      const delay = code === 'delayed'
        ? (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 16) })()
        : undefined
      return api.bulkStatus(checkedIds, code, comment || undefined, delay)
    },
    onSuccess: done('Статус'),
  })

  const busy = assign.isPending || setType.isPending || setStatus.isPending

  if (checkedIds.length === 0) {
    return notice ? (
      <div className="flex items-center gap-2 px-4 py-2 bg-success/10 border-b border-success/30 text-xs text-success">
        <Check size={14} /><span>{notice}</span>
        <button onClick={() => setNotice(null)} className="ml-auto text-success/60 hover:text-success"><X size={14} /></button>
      </div>
    ) : null
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-accent/10 border-b border-accent/30 flex-wrap">
      <span className="text-xs font-semibold text-white">{checkedIds.length} выбрано</span>
      {busy && <span className="text-[10px] text-muted animate-pulse">применяю...</span>}

      <Dropdown label="Ответственный">
        {(close) => <EmployeeMenu onPick={emp => { assign.mutate(emp.id); close() }} />}
      </Dropdown>

      <Dropdown label="Тип">
        {(close) => <TypeMenu onPick={t => { setType.mutate(t.code); close() }} />}
      </Dropdown>

      <Dropdown label="Статус">
        {(close) => BULK_STATUSES.map(s => (
          <button key={s.code} onClick={() => { setStatus.mutate(s.code); close() }}
            className="w-full text-left px-4 py-1.5 text-xs text-white hover:bg-white/5">{s.label}</button>
        ))}
      </Dropdown>

      <div className="flex items-center gap-1.5 flex-1 min-w-[180px]">
        <input
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Комментарий (для статуса)"
          className="flex-1 bg-base border border-border rounded px-2.5 py-1 text-xs focus:outline-none focus:border-accent"
        />
        <TemplatePicker onSelect={text => setComment(text)} />
      </div>

      <button onClick={clearChecked} className="flex items-center gap-1 text-xs text-muted hover:text-white px-2"><X size={13} /> снять</button>
    </div>
  )
}

function IssueRow({ issue, highlighted, checked, onToggle, onClick }: { issue: Issue; highlighted: boolean; checked: boolean; onToggle: () => void; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-border cursor-pointer transition-colors text-sm ${
        highlighted ? 'bg-accent/10' : checked ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]'
      }`}
    >
      <td className="px-3 py-2.5 w-8" onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={onToggle} className="ck cursor-pointer" />
      </td>
      <td className="px-3 py-2.5 text-xs font-mono text-muted w-24 whitespace-nowrap">
        {highlighted && <ChevronRight size={12} className="inline text-accent mr-0.5 -mt-0.5" />}
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
  const { status, company, search, assignee, issueId, page, limit, selectedIssueId, highlightId, checkedIds, setPage, setLimit, selectIssue, toggleChecked, setChecked, clearChecked } = useIssuesStore()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['issues', { status, company, search, assignee, issueId, page, limit }],
    queryFn: () => api.listIssues({
      status: status || undefined,
      company: company || undefined,
      search: search || undefined,
      assignee: assignee || undefined,
      issue_id: issueId ? Number(issueId) : undefined,
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
  const pageIds = issues.map((i: Issue) => i.id)
  const allChecked = pageIds.length > 0 && pageIds.every((id: number) => checkedIds.includes(id))

  return (
    <div className="flex flex-col h-full min-h-0">
      <BulkActionBar />
      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 bg-base z-10">
            <tr className="border-b border-border text-muted text-xs uppercase tracking-wider">
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => allChecked ? clearChecked() : setChecked(pageIds)}
                  className="ck cursor-pointer"
                />
              </th>
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
                highlighted={issue.id === highlightId}
                checked={checkedIds.includes(issue.id)}
                onToggle={() => toggleChecked(issue.id)}
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
              className="flex items-center px-2 py-1 rounded-lg border border-border hover:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            ><ChevronLeft size={14} /></button>
            <span className="px-3">{page} / {pagination.total_pages}</span>
            <button
              disabled={page >= pagination.total_pages}
              onClick={() => setPage(page + 1)}
              className="flex items-center px-2 py-1 rounded-lg border border-border hover:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            ><ChevronRight size={14} /></button>
          </div>
        </div>
      )}
    </div>
  )
}
