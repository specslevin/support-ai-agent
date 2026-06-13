import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useUserStore, EMPLOYEES } from '../store/userStore'
import { StatusBadge } from './StatusBadge'
import type { OkdeskDetail, Template } from '../types'

function formatDate(iso: string | null | undefined) {
  if (!iso) return null
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function isOverdue(iso: string | null | undefined): boolean {
  if (!iso) return false
  return new Date(iso) < new Date()
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-muted">{label}</span>
      <span>{children}</span>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">{title}</h3>
      {children}
    </div>
  )
}

function AssigneeSection({ issueId, assigneeName }: { issueId: number; assigneeName: string | null }) {
  const queryClient = useQueryClient()
  const { currentUser } = useUserStore()
  const [pickerOpen, setPickerOpen] = useState(false)

  const assignMutation = useMutation({
    mutationFn: (employeeId: number) => api.assignIssue(issueId, employeeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      setPickerOpen(false)
    },
  })

  const groups = EMPLOYEES.reduce<Record<string, typeof EMPLOYEES>>((acc, e) => {
    ;(acc[e.group] ??= []).push(e)
    return acc
  }, {})

  return (
    <div className="flex items-center gap-2 text-xs relative">
      <span className="text-muted shrink-0">Ответственный</span>
      <span className={`flex-1 ${assigneeName ? 'text-white' : 'text-muted/50'}`}>
        {assigneeName ?? 'Не назначен'}
      </span>

      {currentUser && currentUser.name !== assigneeName && (
        <button
          onClick={() => assignMutation.mutate(currentUser.id)}
          disabled={assignMutation.isPending}
          className="text-[10px] px-2 py-0.5 rounded border border-accent/50 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 shrink-0"
        >
          Взять себе
        </button>
      )}

      <div className="relative shrink-0">
        <button
          onClick={() => setPickerOpen(o => !o)}
          disabled={assignMutation.isPending}
          className="text-[10px] px-2 py-0.5 rounded border border-border hover:border-accent text-muted hover:text-white transition-colors disabled:opacity-40"
        >
          ▾
        </button>

        {pickerOpen && (
          <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg py-1 z-50 w-40 shadow-xl">
            {Object.entries(groups).map(([group, members]) => (
              <div key={group}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted/60">{group}</div>
                {members.map(emp => (
                  <button
                    key={emp.id}
                    onClick={() => assignMutation.mutate(emp.id)}
                    className={`w-full text-left px-4 py-1.5 text-xs hover:bg-white/5 transition-colors ${emp.name === assigneeName ? 'text-accent' : 'text-white'}`}
                  >
                    {emp.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {pickerOpen && <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />}
      </div>

      {assignMutation.isPending && (
        <span className="text-[10px] text-muted animate-pulse shrink-0">Сохранение...</span>
      )}
    </div>
  )
}

function OkdeskInfo({ d, issueId, assigneeName }: { d: OkdeskDetail; issueId: number; assigneeName: string | null }) {
  const deadline = formatDate(d.deadline_at)
  const overdue = isOverdue(d.deadline_at)
  const description = stripHtml(d.description)

  return (
    <div className="space-y-4 text-xs">
      {/* Участники */}
      <Section title="Участники">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {d.author_name && <MetaRow label="Автор">{d.author_name}</MetaRow>}
          {d.service_object_name && <MetaRow label="Объект">{d.service_object_name}</MetaRow>}
          {d.type_name && <MetaRow label="Тип">{d.type_name}</MetaRow>}
          {d.source && <MetaRow label="Источник">{d.source}</MetaRow>}
        </div>
        <AssigneeSection issueId={issueId} assigneeName={assigneeName} />
      </Section>

      {/* Сроки */}
      <Section title="Сроки">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {deadline && (
            <MetaRow label="Срок выполнения">
              <span className={overdue ? 'text-red-400' : ''}>
                {deadline} {overdue && '⚠'}
              </span>
            </MetaRow>
          )}
          {d.completed_at && <MetaRow label="Завершена">{formatDate(d.completed_at)}</MetaRow>}
          {d.delayed_to && <MetaRow label="Отложена до">{formatDate(d.delayed_to)}</MetaRow>}
          {d.planned_reaction_at && <MetaRow label="Плановая реакция">{formatDate(d.planned_reaction_at)}</MetaRow>}
          {d.reacted_at && <MetaRow label="Фактическая реакция">{formatDate(d.reacted_at)}</MetaRow>}
          {d.spent_time_total != null && d.spent_time_total > 0 && (
            <MetaRow label="Потрачено">
              {d.spent_time_total} ч.
            </MetaRow>
          )}
        </div>
      </Section>

      {/* Параметры (custom fields) */}
      {d.parameters.length > 0 && (
        <Section title="Параметры">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {d.parameters.map(p => (
              <MetaRow key={p.name} label={p.name}>{p.value}</MetaRow>
            ))}
          </div>
        </Section>
      )}

      {/* Описание */}
      {description && (
        <Section title="Описание">
          <p className="text-white/80 leading-relaxed whitespace-pre-wrap bg-surface rounded-lg px-3 py-2.5">
            {description}
          </p>
        </Section>
      )}

      {/* Связанные заявки */}
      {(d.parent_id || d.child_ids.length > 0) && (
        <Section title="Связанные заявки">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {d.parent_id && <MetaRow label="Родительская">#{d.parent_id}</MetaRow>}
            {d.child_ids.length > 0 && (
              <MetaRow label="Дочерние">{d.child_ids.map(id => `#${id}`).join(', ')}</MetaRow>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}

const CATEGORY_COLORS: Record<string, string> = {
  primary: 'text-blue-400',
  secondary: 'text-gray-400',
  success: 'text-green-400',
  danger: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-cyan-400',
  dark: 'text-gray-500',
}

function TemplatePicker({ onSelect }: { onSelect: (content: string) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.listTemplates(),
    staleTime: 5 * 60_000,
  })

  const grouped = useMemo(() => {
    const filtered = search
      ? templates.filter(t =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          t.content.toLowerCase().includes(search.toLowerCase())
        )
      : templates

    return filtered.reduce<Record<string, Template[]>>((acc, t) => {
      const key = t.category_name ?? 'Другое'
      ;(acc[key] ??= []).push(t)
      return acc
    }, {})
  }, [templates, search])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Шаблоны ответов"
        className="shrink-0 px-2.5 py-1.5 text-xs bg-surface border border-border hover:border-accent rounded transition-colors"
      >
        📋
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      <div className="fixed inset-0 bg-black/60" onClick={() => setOpen(false)} />
      <div className="relative bg-surface border border-border rounded-xl w-full max-w-md max-h-[70vh] flex flex-col shadow-2xl z-10">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-semibold">Шаблоны ответов</span>
          <button onClick={() => setOpen(false)} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="px-4 py-2 border-b border-border shrink-0">
          <input
            autoFocus
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-base border border-border rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
          />
        </div>
        <div className="overflow-y-auto flex-1 py-2">
          {Object.keys(grouped).length === 0 && (
            <p className="text-xs text-muted px-4 py-3">Шаблоны не найдены</p>
          )}
          {Object.entries(grouped).map(([cat, items]) => {
            const color = CATEGORY_COLORS[items[0]?.category_color ?? ''] ?? 'text-gray-400'
            return (
              <div key={cat}>
                <div className={`px-4 py-1 text-[10px] uppercase tracking-widest font-semibold ${color}`}>{cat}</div>
                {items.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { onSelect(t.content); setOpen(false); setSearch('') }}
                    className="w-full text-left px-4 py-2 hover:bg-white/5 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white flex-1">{t.name}</span>
                      {t.is_favorite && <span className="text-yellow-400 text-[10px]">★</span>}
                      {t.usage_count > 0 && (
                        <span className="text-[10px] text-muted">{t.usage_count}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted mt-0.5 line-clamp-2 leading-relaxed">{t.content}</p>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const STATUS_OPTIONS = [
  { code: 'completed', label: 'Решена', color: 'text-green-400 border-green-500/50 hover:bg-green-500/10' },
  { code: 'delayed',   label: 'Ожидание ответа', color: 'text-yellow-400 border-yellow-500/50 hover:bg-yellow-500/10' },
]

const OKDESK_WEB_BASE = 'https://gpspos.okdesk.ru'

function ResolveModal({
  issueId,
  externalId,
  typeCode,
  onClose,
  onDone,
}: {
  issueId: number
  externalId: number
  typeCode: string | null
  onClose: () => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [selectedStatus, setSelectedStatus] = useState('completed')
  const [comment, setComment] = useState('')

  const typeIsDefault = !typeCode || typeCode === 'inner'

  const resolve = useMutation({
    mutationFn: () => api.resolveIssue(issueId, selectedStatus, comment),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['comments', issueId] })
      onDone()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-xl w-full max-w-lg shadow-2xl z-10">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">Решить заявку #{externalId}</h2>
          <button onClick={onClose} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Type warning */}
          {typeIsDefault && (
            <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2.5 text-xs">
              <span className="text-yellow-400 text-base shrink-0">⚠</span>
              <div className="space-y-1">
                <p className="text-yellow-300 font-medium">Тип заявки не указан</p>
                <p className="text-yellow-300/70">
                  Тип «Внутренняя» — значение по умолчанию. Укажите корректный тип в Okdesk перед изменением статуса.
                </p>
                <a
                  href={`${OKDESK_WEB_BASE}/issues/${externalId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-yellow-400 hover:text-yellow-300 underline underline-offset-2"
                >
                  Открыть в Okdesk ↗
                </a>
              </div>
            </div>
          )}

          {/* Status selector */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">Новый статус</p>
            <div className="flex gap-2">
              {STATUS_OPTIONS.map(opt => (
                <button
                  key={opt.code}
                  onClick={() => setSelectedStatus(opt.code)}
                  className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    selectedStatus === opt.code
                      ? opt.color + ' bg-white/5'
                      : 'border-border text-muted hover:border-accent/50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Comment with template picker */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">
              Комментарий <span className="text-red-400">*</span>
            </p>
            <div className="flex items-start gap-2">
              <textarea
                placeholder="Введите текст или выберите шаблон..."
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={5}
                className="flex-1 bg-base border border-border rounded px-3 py-2 text-xs resize-none focus:outline-none focus:border-accent leading-relaxed"
              />
              <TemplatePicker onSelect={text => setComment(text)} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="text-xs text-muted hover:text-white transition-colors">
            Отмена
          </button>
          <button
            disabled={!comment.trim() || typeIsDefault || resolve.isPending}
            onClick={() => resolve.mutate()}
            className="px-4 py-2 rounded-lg bg-green-600/90 hover:bg-green-600 text-white text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {resolve.isPending ? (
              <span className="animate-pulse">Отправка...</span>
            ) : (
              <>✓ Отправить и {STATUS_OPTIONS.find(s => s.code === selectedStatus)?.label.toLowerCase()}</>
            )}
          </button>
        </div>

        {resolve.isError && (
          <p className="px-5 pb-4 text-xs text-red-400">Ошибка при отправке. Попробуйте снова.</p>
        )}
      </div>
    </div>
  )
}

export function IssueDetail() {
  const { selectedIssueId, selectIssue } = useIssuesStore()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [mileage, setMileage] = useState('')
  const [notes, setNotes] = useState('')
  const [resolveOpen, setResolveOpen] = useState(false)

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

  const { issue, okdesk_detail: od, latest_analysis } = data

  return (
    <>
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-muted text-xs font-mono">#{issue.external_id}</span>
            <StatusBadge status={issue.status} />
            {issue.priority && <span className="text-xs text-muted">{issue.priority}</span>}
          </div>
          <h2 className="text-sm font-semibold leading-snug">{issue.subject ?? '—'}</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {od && issue.status !== 'completed' && (
            <button
              onClick={() => setResolveOpen(true)}
              title={(!od.type_code || od.type_code === 'inner') ? 'Тип заявки не указан' : 'Изменить статус с комментарием'}
              className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                (!od.type_code || od.type_code === 'inner')
                  ? 'border-yellow-500/40 text-yellow-400/60 cursor-not-allowed'
                  : 'border-green-500/50 text-green-400 hover:bg-green-500/10'
              }`}
            >
              Решить
            </button>
          )}
          <button onClick={() => selectIssue(null)} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>
      </div>

      <div className="flex-1 px-5 py-4 space-y-5">
        {/* Клиент + даты кэша */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <span className="text-muted">Компания</span>
          <span>{issue.company_name ?? '—'}</span>
          <span className="text-muted">Контакт</span>
          <span>{issue.contact_name ?? '—'}</span>
          <span className="text-muted">Создана</span>
          <span>{formatDate(issue.created_at) ?? '—'}</span>
          <span className="text-muted">Изменена</span>
          <span>{formatDate(issue.updated_at) ?? '—'}</span>
        </div>

        {/* Live Okdesk info */}
        {od && <OkdeskInfo d={od} issueId={issue.id} assigneeName={issue.assignee_name ?? null} />}

        {/* Если okdesk_detail пустой — показываем только assignee picker */}
        {!od && (
          <AssigneeSection issueId={issue.id} assigneeName={issue.assignee_name ?? null} />
        )}

        {/* Analysis */}
        <div className="border border-border rounded-lg p-4 space-y-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">Анализ пробега</h3>

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
            <input
              type="number"
              placeholder="Пробег по путевому листу (км)"
              value={mileage}
              onChange={e => setMileage(e.target.value)}
              className="w-full bg-base border border-border rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
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
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">
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
            {comments.length === 0 && <p className="text-xs text-muted">Комментариев нет</p>}
          </div>

          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <textarea
                placeholder="Написать комментарий..."
                value={comment}
                onChange={e => setComment(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment) {
                    addComment.mutate(comment)
                  }
                }}
                rows={3}
                className="flex-1 bg-base border border-border rounded px-3 py-1.5 text-xs resize-none focus:outline-none focus:border-accent"
              />
              <div className="flex flex-col gap-1.5 shrink-0">
                <TemplatePicker onSelect={text => setComment(text)} />
                <button
                  disabled={!comment || addComment.isPending}
                  onClick={() => addComment.mutate(comment)}
                  title="Отправить (Ctrl+Enter)"
                  className="bg-surface border border-border hover:border-accent rounded px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
                >
                  {addComment.isPending ? '...' : '↵'}
                </button>
              </div>
            </div>
            {comment && (
              <p className="text-[10px] text-muted">Ctrl+Enter — отправить</p>
            )}
          </div>
        </div>
      </div>
    </div>

    {resolveOpen && od && (
      <ResolveModal
        issueId={issue.id}
        externalId={issue.external_id}
        typeCode={od.type_code}
        onClose={() => setResolveOpen(false)}
        onDone={() => setResolveOpen(false)}
      />
    )}
    </>
  )
}
