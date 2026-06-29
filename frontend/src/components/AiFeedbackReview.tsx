import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, X, ThumbsUp, ThumbsDown, ExternalLink, Loader2, AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useAuthStore } from '../store/authStore'
import type { AiFeedbackRating } from '../types'

const ERROR_KIND_LABEL: Record<string, string> = {
  wrong_verdict: 'Неверный вердикт',
  wrong_plate: 'Неверный гос.номер',
  wrong_date: 'Неверная дата',
  wrong_mileage: 'Неверный пробег',
  other: 'Другое',
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Просмотр оценок ИИ-разбора: вкладки «Хорошо разобрано» / «С ошибками».
 * Каждый элемент — ссылка на заявку (открывает её в карточке через issuesStore).
 */
export function AiFeedbackReview({ onOpenIssue }: { onOpenIssue?: () => void }) {
  const [tab, setTab] = useState<AiFeedbackRating>('bad')
  const [hideResolved, setHideResolved] = useState(true)
  const selectIssue = useIssuesStore(s => s.selectIssue)
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const queryClient = useQueryClient()

  const { data, isPending, isError } = useQuery({
    queryKey: ['ai-feedback-list', tab],
    queryFn: () => api.listAiFeedback(tab),
    staleTime: 30_000,
  })

  const resolveMut = useMutation({
    mutationFn: ({ id, resolved }: { id: number; resolved: boolean }) =>
      api.resolveAiFeedback(id, resolved),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-feedback-list'] }),
  })

  const openIssue = async (externalId: number) => {
    try {
      const res = await api.listIssues({ issue_id: externalId, limit: 1 })
      if (res.data[0]) {
        selectIssue(res.data[0].id)
        onOpenIssue?.()
      }
    } catch {
      /* noop — заявки может не быть в кэше */
    }
  }

  const allItems = data?.items ?? []
  const items = (tab === 'bad' && hideResolved)
    ? allItems.filter(it => !it.resolved)
    : allItems
  const resolvedCount = allItems.filter(it => it.resolved).length

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Вкладки */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab('good')}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
              tab === 'good'
                ? 'border-green-500/60 bg-green-500/10 text-green-400'
                : 'border-border text-muted hover:text-white'
            }`}
          >
            <ThumbsUp size={14} /> Хорошо разобрано
          </button>
          <button
            onClick={() => setTab('bad')}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
              tab === 'bad'
                ? 'border-orange-500/60 bg-orange-500/10 text-orange-400'
                : 'border-border text-muted hover:text-white'
            }`}
          >
            <ThumbsDown size={14} /> С ошибками
          </button>
          {data && <span className="text-xs text-muted ml-1">({items.length})</span>}
          {tab === 'bad' && resolvedCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-muted ml-auto cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideResolved}
                onChange={e => setHideResolved(e.target.checked)}
                className="w-3.5 h-3.5 accent-accent"
              />
              Скрыть исправленные ({resolvedCount})
            </label>
          )}
        </div>

        {isPending && (
          <div className="flex items-center gap-2 text-sm text-muted py-6">
            <Loader2 size={16} className="animate-spin text-accent" /> Загрузка…
          </div>
        )}

        {isError && (
          <p className="flex items-center gap-1.5 text-sm text-orange-400 py-6">
            <AlertTriangle size={15} /> Не удалось загрузить оценки.
          </p>
        )}

        {!isPending && !isError && items.length === 0 && (
          <p className="text-sm text-muted py-6">Оценок пока нет.</p>
        )}

        <div className="space-y-2">
          {items.map(it => (
            <div
              key={it.id}
              className={`border rounded-lg px-4 py-3 space-y-1.5 text-xs ${
                it.resolved ? 'bg-card/50 border-green-500/40 opacity-70' : 'bg-card border-border'
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => openIssue(it.issue_external_id)}
                  className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
                >
                  #{it.issue_external_id} <ExternalLink size={11} />
                </button>
                {it.rating === 'good' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium">
                    <Check size={11} /> верно
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 font-medium">
                    <X size={11} /> с ошибкой
                  </span>
                )}
                {it.resolved && (
                  <span
                    title={`Исправлено${it.resolved_by ? ` (${it.resolved_by})` : ''}${it.resolved_at ? ` ${formatDate(it.resolved_at)}` : ''}`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium"
                  >
                    <CheckCircle2 size={11} /> исправлено
                  </span>
                )}
                {it.error_kind && (
                  <span className="text-warning">{ERROR_KIND_LABEL[it.error_kind] ?? it.error_kind}</span>
                )}
                {it.ai_category && (
                  <span className="text-muted">вердикт ИИ: <span className="text-white/80">{it.ai_category}</span></span>
                )}
                <span className="ml-auto text-muted/70 shrink-0">{formatDate(it.created_at)}</span>
              </div>
              {it.comment && (
                <p className="text-white/80 leading-relaxed whitespace-pre-wrap">{it.comment}</p>
              )}
              {it.correct_category && (
                <p className="text-muted">Правильная категория: <span className="text-white/80">{it.correct_category}</span></p>
              )}
              <div className="flex items-center gap-2">
                {it.created_by && <span className="text-muted/70">{it.created_by}</span>}
                {it.rating === 'bad' && !isDemo && (
                  <button
                    onClick={() => resolveMut.mutate({ id: it.id, resolved: !it.resolved })}
                    disabled={resolveMut.isPending}
                    className={`ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-medium transition-colors disabled:opacity-50 ${
                      it.resolved
                        ? 'border-border text-muted hover:text-white'
                        : 'border-green-500/50 text-green-400 hover:bg-green-500/10'
                    }`}
                  >
                    {it.resolved ? (<><RotateCcw size={12} /> Вернуть в работу</>) : (<><CheckCircle2 size={12} /> Исправлено</>)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
