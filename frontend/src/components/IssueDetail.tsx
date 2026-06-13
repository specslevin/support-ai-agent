import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { StatusBadge } from './StatusBadge'

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function IssueDetail() {
  const { selectedIssueId, selectIssue } = useIssuesStore()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [mileage, setMileage] = useState('')
  const [notes, setNotes] = useState('')

  const { data, isPending } = useQuery({
    queryKey: ['issue', selectedIssueId],
    queryFn: () => api.getIssue(selectedIssueId!),
    enabled: selectedIssueId != null,
  })

  const { data: comments = [] } = useQuery({
    queryKey: ['comments', selectedIssueId],
    queryFn: () => api.getComments(selectedIssueId!),
    enabled: selectedIssueId != null,
    staleTime: 30_000,
  })

  const addComment = useMutation({
    mutationFn: (text: string) => api.addComment(selectedIssueId!, text),
    onSuccess: () => {
      setComment('')
      queryClient.invalidateQueries({ queryKey: ['comments', selectedIssueId] })
    },
  })

  const submitAnalysis = useMutation({
    mutationFn: () => api.submitAnalysis(selectedIssueId!, parseFloat(mileage), notes || undefined),
    onSuccess: () => {
      setMileage('')
      setNotes('')
      queryClient.invalidateQueries({ queryKey: ['issue', selectedIssueId] })
    },
  })

  if (!selectedIssueId) return null

  if (isPending || !data) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Загрузка...
      </div>
    )
  }

  const { issue, latest_analysis } = data

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-muted text-xs font-mono">#{issue.external_id}</span>
            <StatusBadge status={issue.status} />
            {issue.priority && (
              <span className="text-xs text-muted">{issue.priority}</span>
            )}
          </div>
          <h2 className="text-sm font-semibold leading-snug">{issue.subject ?? '—'}</h2>
        </div>
        <button
          onClick={() => selectIssue(null)}
          className="text-muted hover:text-white text-lg leading-none"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 px-5 py-4 space-y-5">
        {/* Meta */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <span className="text-muted">Компания</span>
          <span>{issue.company_name ?? '—'}</span>
          <span className="text-muted">Контакт</span>
          <span>{issue.contact_name ?? '—'}</span>
          <span className="text-muted">Создана</span>
          <span>{formatDate(issue.created_at)}</span>
          <span className="text-muted">Синхронизирована</span>
          <span>{formatDate(issue.synced_at)}</span>
        </div>

        {/* Analysis */}
        <div className="border border-border rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Анализ пробега</h3>

          {latest_analysis ? (
            <div className="text-xs space-y-1.5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="text-muted">Путевой лист</span>
                <span>{latest_analysis.mileage_from_sheet?.toLocaleString('ru-RU')} км</span>
                <span className="text-muted">По системе</span>
                <span>{latest_analysis.mileage_from_system?.toLocaleString('ru-RU') ?? '—'} км</span>
                {latest_analysis.discrepancy_percent != null && (
                  <>
                    <span className="text-muted">Расхождение</span>
                    <span className={latest_analysis.discrepancy_percent > 5 ? 'text-red-400' : 'text-green-400'}>
                      {latest_analysis.discrepancy_percent.toFixed(1)}%
                    </span>
                  </>
                )}
              </div>
              {latest_analysis.ai_suggestion && (
                <p className="text-muted mt-2 leading-relaxed">{latest_analysis.ai_suggestion}</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted">Анализ не проводился</p>
          )}

          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Пробег по путевому листу (км)"
                value={mileage}
                onChange={e => setMileage(e.target.value)}
                className="flex-1 bg-base border border-border rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
              />
            </div>
            <textarea
              placeholder="Примечания (необязательно)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="w-full bg-base border border-border rounded px-3 py-1.5 text-xs resize-none focus:outline-none focus:border-accent"
            />
            <button
              disabled={!mileage || submitAnalysis.isPending}
              onClick={() => submitAnalysis.mutate()}
              className="w-full bg-accent/90 hover:bg-accent text-black text-xs font-semibold py-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitAnalysis.isPending ? 'Сохранение...' : 'Сохранить анализ'}
            </button>
          </div>
        </div>

        {/* Comments */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            Комментарии {comments.length > 0 && `(${comments.length})`}
          </h3>

          <div className="space-y-2">
            {comments.map(c => (
              <div key={c.id} className="bg-surface rounded-lg px-3 py-2.5 text-xs space-y-0.5">
                <div className="flex items-center justify-between text-muted">
                  <span className="font-medium text-white/70">{c.author}</span>
                  <span>{formatDate(c.created_at)}</span>
                </div>
                <p className="leading-relaxed">{c.content ?? ''}</p>
              </div>
            ))}
            {comments.length === 0 && (
              <p className="text-xs text-muted">Комментариев нет</p>
            )}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Написать комментарий..."
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && comment && addComment.mutate(comment)}
              className="flex-1 bg-base border border-border rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
            <button
              disabled={!comment || addComment.isPending}
              onClick={() => addComment.mutate(comment)}
              className="bg-surface border border-border hover:border-accent rounded px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
            >
              ↵
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
