import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo, useEffect } from 'react'
import {
  ChevronDown, AlertTriangle, X, Check, Star, Bot, RefreshCw, Database,
  Lightbulb, ArrowDown, ArrowLeft, Map, FilePlus, ExternalLink, Pause, Send,
  Layers, Power, RadioTower, Scissors, HelpCircle, FileText, Sheet,
  Image as ImageIcon, Paperclip, PanelRightClose, Info, MessageSquare, Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useUserStore } from '../store/userStore'
import { StatusBadge } from './StatusBadge'
import { EmployeeMenu, TypeMenu } from './pickers'
import type { OkdeskDetail, Template, AutomationResult, Analysis, BatchResult } from '../types'

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

/** Верхнеуровневый блок карточки: иконка + заголовок + контент (логическое разделение) */
function Block({ icon: Icon, title, count, right, children }: {
  icon: LucideIcon
  title: string
  count?: number | null
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-accent shrink-0" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">{title}</h3>
        {count != null && <span className="text-[10px] text-muted">({count})</span>}
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </section>
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
          className="text-[10px] px-2 py-0.5 rounded-lg border border-accent/50 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 shrink-0"
        >
          Взять себе
        </button>
      )}

      <div className="relative shrink-0">
        <button
          onClick={() => setPickerOpen(o => !o)}
          disabled={assignMutation.isPending}
          className="flex items-center px-1.5 py-0.5 rounded-lg border border-border hover:border-accent text-muted hover:text-white transition-colors disabled:opacity-40"
        >
          <ChevronDown size={13} />
        </button>

        {pickerOpen && (
          <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg py-1 z-50 w-40 shadow-lg">
            <EmployeeMenu selectedName={assigneeName} onPick={emp => assignMutation.mutate(emp.id)} />
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

function TypeSection({ issueId, typeName, typeCode }: { issueId: number; typeName: string | null; typeCode: string | null }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const mutation = useMutation({
    mutationFn: (code: string) => api.changeIssueType(issueId, code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      setOpen(false)
    },
  })

  const isDefault = !typeCode || typeCode === 'inner'

  return (
    <div className="col-span-2 flex items-center gap-2 relative">
      <span className="text-muted shrink-0">Тип</span>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 text-left hover:text-white transition-colors ${isDefault ? 'text-warning' : 'text-white'}`}
      >
        {isDefault && !mutation.isPending && <AlertTriangle size={12} />}
        {mutation.isPending ? 'Меняю…' : isDefault ? 'Не указан — нажмите чтобы выбрать' : typeName}
        <ChevronDown size={12} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-10 top-full mt-1 z-50 bg-card border border-border rounded-lg py-1 min-w-[200px] max-h-72 overflow-y-auto shadow-lg">
            <TypeMenu selectedCode={typeCode} onPick={t => { mutation.mutate(t.code); setOpen(false) }} />
          </div>
        </>
      )}
    </div>
  )
}

function OkdeskInfo({ d, issueId, assigneeName, onOpenExternal }: { d: OkdeskDetail; issueId: number; assigneeName: string | null; onOpenExternal: (extId: number) => void }) {
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
          <TypeSection issueId={issueId} typeName={d.type_name} typeCode={d.type_code} />
          {d.source && <MetaRow label="Источник">{d.source}</MetaRow>}
        </div>
        <AssigneeSection issueId={issueId} assigneeName={assigneeName} />
      </Section>

      {/* Сроки */}
      <Section title="Сроки">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {deadline && (
            <MetaRow label="Срок выполнения">
              <span className={`inline-flex items-center gap-1 ${overdue ? 'text-orange-400' : ''}`}>
                {deadline} {overdue && <AlertTriangle size={11} />}
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

      {/* Описание (вопрос клиента) */}
      <Section title="Вопрос клиента">
        <p className="text-white/80 leading-relaxed whitespace-pre-wrap bg-frame rounded-lg px-3 py-2.5">
          {description || <span className="text-muted/60">Текст отсутствует — см. тему и параметры заявки</span>}
        </p>
      </Section>

      {/* Связанные заявки */}
      {(d.parent_id || d.child_ids.length > 0) && (
        <Section title="Связанные заявки">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {d.parent_id && (
              <MetaRow label="Родительская">
                <button onClick={() => onOpenExternal(d.parent_id!)} className="text-accent hover:underline">#{d.parent_id}</button>
              </MetaRow>
            )}
            {d.child_ids.length > 0 && (
              <MetaRow label="Дочерние">
                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {d.child_ids.map(id => (
                    <button key={id} onClick={() => onOpenExternal(id)} className="text-accent hover:underline">#{id}</button>
                  ))}
                </span>
              </MetaRow>
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

export function TemplatePicker({ onSelect, onSelectFull }: { onSelect: (content: string) => void; onSelectFull?: (t: { name: string; content: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const setLastTemplate = useIssuesStore(s => s.setLastTemplate)

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.listTemplates(),
    staleTime: 5 * 60_000,
  })

  const handleSelect = (t: Template) => {
    setLastTemplate(t.content)
    if (onSelectFull) {
      onSelectFull({ name: t.name, content: t.content })
    } else {
      onSelect(t.content)
    }
    setOpen(false)
    setSearch('')
  }

  // Categories ordered by their most-used template; items within by usage desc.
  const grouped = useMemo(() => {
    const filtered = search
      ? templates.filter(t =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          t.content.toLowerCase().includes(search.toLowerCase())
        )
      : templates

    const byCat = filtered.reduce<Record<string, Template[]>>((acc, t) => {
      const key = t.category_name ?? 'Другое'
      ;(acc[key] ??= []).push(t)
      return acc
    }, {})
    for (const items of Object.values(byCat)) {
      items.sort((a, b) => b.usage_count - a.usage_count)
    }
    return Object.fromEntries(
      Object.entries(byCat).sort(
        ([, a], [, b]) => (b[0]?.usage_count ?? 0) - (a[0]?.usage_count ?? 0),
      ),
    )
  }, [templates, search])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Шаблоны ответов"
        className="flex items-center justify-center shrink-0 px-2.5 py-1.5 bg-frame border border-border hover:border-accent rounded-lg transition-colors text-muted hover:text-accent"
      >
        <FileText size={15} />
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      <div className="fixed inset-0 bg-black/60" onClick={() => setOpen(false)} />
      <div className="relative bg-card border border-border rounded-xl w-full max-w-md max-h-[70vh] flex flex-col shadow-lg z-10">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-semibold">Шаблоны ответов</span>
          <button onClick={() => setOpen(false)} className="text-muted hover:text-white"><X size={18} /></button>
        </div>
        <div className="px-4 py-2 border-b border-border shrink-0">
          <input
            autoFocus
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-frame border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
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
                    onClick={() => handleSelect(t)}
                    className="w-full text-left px-4 py-2 hover:bg-white/5 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white flex-1">{t.name}</span>
                      {t.is_favorite && <Star size={11} className="text-warning fill-warning" />}
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

// All Okdesk statuses with their actual colors and rules
const ALL_STATUSES = [
  { code: 'opened',   label: 'Открыть',            bg: '#3edad8', commentRequired: false, needsDelay: false },
  { code: 'wait',     label: 'В работу',            bg: '#2b6684', commentRequired: false, needsDelay: false },
  { code: 'delayed',  label: 'Ожидание ответа',     bg: '#bb7db2', commentRequired: true,  needsDelay: true  },
  { code: 'no_time',  label: 'Отложить',            bg: '#f68741', commentRequired: true,  needsDelay: true  },
  { code: 'completed',label: 'Решить',              bg: '#67a030', commentRequired: false, needsDelay: false },
  { code: 'closed',   label: 'Закрыть',             bg: '#787880', commentRequired: false, needsDelay: false },
]

const DEPARTURE_TYPES = new Set(['departure', 'departure_fuel'])
const FINAL_STATUSES  = new Set(['completed', 'closed', 'inst_fin'])

function getAvailableStatuses(currentStatus: string | null, typeCode: string | null) {
  const typeIsDefault = !typeCode || typeCode === 'inner'
  const isDeparture   = typeCode ? DEPARTURE_TYPES.has(typeCode) : false

  return ALL_STATUSES.filter(s => {
    if (s.code === currentStatus) return false
    if (s.code === 'wait' && !isDeparture) return false
    if (FINAL_STATUSES.has(s.code) && typeIsDefault) return false
    return true
  })
}

// Modal shown after picking a status — comment + optional delay_to
function StatusActionModal({
  issueId,
  externalId,
  targetStatus,
  onClose,
  onDone,
}: {
  issueId: number
  externalId: number
  targetStatus: typeof ALL_STATUSES[number]
  onClose: () => void
  onDone: (notice?: string) => void
}) {
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [commentPublic, setCommentPublic] = useState(true)
  const [delayTo, setDelayTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 3)
    return d.toISOString().slice(0, 16)
  })

  const mutation = useMutation({
    mutationFn: () => api.resolveIssue(issueId, targetStatus.code, comment, targetStatus.needsDelay ? delayTo : undefined, commentPublic),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['comments', issueId] })
      onDone(!data.status_changed ? 'Статус не изменён — смените вручную в Okdesk.' : undefined)
    },
  })

  const canSubmit = (!targetStatus.commentRequired || comment.trim()) && (!targetStatus.needsDelay || delayTo)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl w-full max-w-md shadow-lg z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: targetStatus.bg }} />
            <h2 className="text-sm font-semibold">{targetStatus.label} — #{externalId}</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {targetStatus.needsDelay && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">
                Отложить до <span className="text-orange-400">*</span>
              </p>
              <input
                type="datetime-local"
                value={delayTo}
                onChange={e => setDelayTo(e.target.value)}
                className="w-full bg-frame border border-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-accent"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">
              Комментарий{targetStatus.commentRequired && <span className="text-orange-400 ml-1">*</span>}
            </p>
            <div className="flex items-start gap-2">
              <textarea
                autoFocus
                placeholder={targetStatus.commentRequired ? 'Обязательный комментарий...' : 'Необязательный комментарий...'}
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={4}
                className="flex-1 bg-frame border border-border rounded-lg px-3 py-2 text-xs resize-none focus:outline-none focus:border-accent leading-relaxed"
              />
              <TemplatePicker onSelect={text => setComment(text)} />
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
              <input
                type="checkbox"
                checked={commentPublic}
                onChange={e => setCommentPublic(e.target.checked)}
                className="w-3.5 h-3.5 accent-accent"
              />
              <span className="text-xs text-muted">Публичный комментарий</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="text-xs text-muted hover:text-white transition-colors">Отмена</button>
          <button
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
            style={{ background: canSubmit && !mutation.isPending ? targetStatus.bg : undefined }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-xs font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-frame disabled:border disabled:border-border"
          >
            {mutation.isPending ? <span className="animate-pulse">Отправка...</span> : <><Check size={14} /> {targetStatus.label}</>}
          </button>
        </div>

        {mutation.isError && (
          <p className="px-5 pb-4 text-xs text-orange-400">Ошибка при отправке. Попробуйте снова.</p>
        )}
      </div>
    </div>
  )
}

const FLAG_META: Record<string, { icon: LucideIcon; label: string }> = {
  power_off: { icon: Power, label: 'Нет питания' },
  jamming: { icon: RadioTower, label: 'Глушение GPS' },
  track_gap: { icon: Scissors, label: 'Обрыв трека' },
  no_data: { icon: AlertTriangle, label: 'Нет данных' },
  object_not_found: { icon: HelpCircle, label: 'Объект не найден' },
}

function Fact({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  if (value == null || value === '') return null
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className={warn ? 'text-warning' : ''}>{value}</span>
    </>
  )
}

function AutoAnalysis({ issueId, onUseDraft, latestAnalysis, issueTitle }: { issueId: number; onUseDraft: (text: string) => void; latestAnalysis: Analysis | null; issueTitle?: string | null }) {
  const queryClient = useQueryClient()
  const [result, setResult] = useState<AutomationResult | null>(null)
  const [confirmResolve, setConfirmResolve] = useState(false)

  // Multi-attachment («общая») issue → single-object analysis is misleading
  // (it picks just the first plate). Defer to «Разбор по объектам» below.
  const { data: attachments = [] } = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })
  const extractCount = attachments.filter(a => a.extractable).length
  // Batch = несколько вложений ИЛИ одно вложение «общей» заявки со списком ТС.
  const isBatch = extractCount >= 2 || (extractCount >= 1 && /общ/i.test(issueTitle ?? ''))

  // Cached result — show last analysis without re-running the AI (saves tokens).
  const cachedQ = useQuery({
    queryKey: ['automate-cached', issueId],
    queryFn: () => api.getCachedAutomate(issueId),
    enabled: !isBatch,
    staleTime: 5 * 60_000,
  })
  const cached = cachedQ.data?.cached ? cachedQ.data : null

  const run = useMutation({
    mutationFn: () => api.automateIssue(issueId),
    onSuccess: (data) => {
      setResult(data)
      setConfirmResolve(false)
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['automate-cached', issueId] })
    },
  })

  const resolve = useMutation({
    mutationFn: (text: string) => api.resolveIssue(issueId, 'completed', text, undefined, true),
    onSuccess: () => {
      setConfirmResolve(false)
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['comments', issueId] })
    },
  })

  const shown = result ?? (cached as AutomationResult | null)
  const t = shown?.telemetry
  const p = shown?.parsed
  const conf = shown ? Math.round(shown.confidence * 100) : 0
  const isCached = !result && !!cached

  if (isBatch) {
    return (
      <p className="flex items-start gap-1.5 text-[11px] text-muted leading-relaxed">
        <Layers size={13} className="shrink-0 mt-0.5" />
        Заявка содержит несколько объектов — используйте «Разбор по объектам» ниже
        (одиночный автоанализ показал бы только один ТС).
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <button
        onClick={() => run.mutate()}
        disabled={run.isPending}
        className="flex items-center justify-center gap-2 w-full bg-card border border-accent/40 text-accent hover:bg-accent/10 text-xs font-semibold py-2 rounded-lg transition-colors disabled:opacity-50"
      >
        {run.isPending ? (
          <><Bot size={14} className="animate-pulse" /> Анализирую заявку и данные geo...</>
        ) : shown ? (
          <><RefreshCw size={14} /> Обновить анализ</>
        ) : (
          <><Bot size={14} /> Автоанализ заявки</>
        )}
      </button>

      {isCached && (
        <p className="flex items-center gap-1 text-[10px] text-muted/70"><Database size={11} /> показан сохранённый анализ{cachedQ.data?.created_at ? ` от ${new Date(cachedQ.data.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      )}

      {run.isError && (
        <p className="text-xs text-orange-400">Ошибка анализа. Попробуйте снова.</p>
      )}

      {shown && (
        <div className="space-y-2.5 text-xs">
          {shown.error && (
            <p className="flex items-start gap-1.5 text-warning"><AlertTriangle size={13} className="shrink-0 mt-0.5" /> {shown.reasoning}</p>
          )}

          {t && (t.object_name || t.system_mileage_km != null) && (
            <div className="bg-frame rounded-lg px-3 py-2.5 space-y-2">
              {t.flags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.flags.map(f => {
                    const m = FLAG_META[f]
                    const FI = m?.icon
                    return (
                      <span key={f} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning/15 text-warning text-[10px]">
                        {FI && <FI size={11} />}{m?.label ?? f}
                      </span>
                    )
                  })}
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <Fact label="Объект" value={t.object_name} />
                <Fact label="Гос.номер" value={p?.plate} />
                <Fact label="Дата неисправности" value={p?.date} />
                <Fact label="Путевой лист" value={p?.sheet_mileage_km != null ? `${p.sheet_mileage_km} км` : null} />
                <Fact label="По системе" value={t.system_mileage_km != null ? `${t.system_mileage_km} км` : null} />
                <Fact label="Макс. скорость" value={t.max_speed != null ? `${t.max_speed} км/ч` : null} />
                <Fact label="В движении" value={t.move_time_min != null ? `${t.move_time_min} мин` : null} />
                <Fact label="Спутники (ср.)" value={t.avg_sat} warn={(t.avg_sat ?? 99) < 6} />
                <Fact label="Питание (мин.)" value={t.min_power_v != null ? `${t.min_power_v} В` : null} warn={(t.min_power_v ?? 99) < 7} />
                <Fact label="Обрыв трека" value={t.max_gap_min != null ? `${t.max_gap_min} мин` : null} warn={(t.max_gap_min ?? 0) > 30} />
                <Fact label="Макс. скорость (пакеты)" value={t.max_speed_packet != null ? `${t.max_speed_packet} км/ч` : null} warn={(t.max_speed_packet ?? 0) > 110} />
                <Fact label="Выбросы скорости" value={t.speed_spike_count > 0 ? `${t.speed_spike_count}` : null} warn={t.speed_spike_count > 0} />
                <Fact label="Телепорты трека" value={t.teleport_jumps > 0 ? `${t.teleport_jumps}` : null} warn={t.teleport_jumps > 0} />
                <Fact label="Пакетов" value={t.packets} />
              </div>
            </div>
          )}

          {shown.draft_answer && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-accent/15 text-accent text-[10px] font-semibold">{shown.category}</span>
                <span className={`text-[10px] ${shown.needs_review ? 'text-warning' : 'text-green-400'}`}>
                  уверенность {conf}%{shown.needs_review ? ' · нужна проверка' : ''}
                </span>
              </div>
              <p className="text-white/90 leading-relaxed bg-frame rounded-lg px-3 py-2.5 whitespace-pre-wrap">
                {shown.draft_answer}
              </p>
              {shown.reasoning && !shown.error && (
                <p className="flex items-start gap-1.5 text-muted leading-relaxed text-[11px]"><Lightbulb size={13} className="shrink-0 mt-0.5" /> {shown.reasoning}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Прошлый анализ */}
      {latestAnalysis && latestAnalysis.mileage_from_system != null && (
        <div className="text-xs space-y-1.5 pt-2 border-t border-border">
          <span className="text-[10px] text-muted/60">Прошлый анализ</span>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-muted">Путевой лист</span>
            <span>{latestAnalysis.mileage_from_sheet?.toLocaleString('ru-RU') ?? '—'} км</span>
            <span className="text-muted">По системе</span>
            <span>{latestAnalysis.mileage_from_system?.toLocaleString('ru-RU')} км</span>
            {latestAnalysis.discrepancy_percent != null && (
              <>
                <span className="text-muted">Расхождение</span>
                <span className={Math.abs(latestAnalysis.discrepancy_percent) > 5 ? 'text-warning' : 'text-green-400'}>
                  {latestAnalysis.discrepancy_percent.toFixed(1)}%
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Действия — в самом низу блока, после всех данных */}
      {shown?.draft_answer && (
        resolve.isSuccess ? (
          <p className="flex items-center justify-center gap-1.5 text-xs text-green-400 py-1.5 border-t border-border"><Check size={14} /> Заявка решена, ответ отправлен клиенту</p>
        ) : (
          <div className="space-y-1.5 pt-2 border-t border-border">
            <div className="flex gap-2">
              <button
                onClick={() => onUseDraft(shown.draft_answer)}
                className="flex items-center justify-center gap-1.5 flex-1 bg-frame border border-border hover:border-accent text-white text-xs font-semibold py-1.5 rounded-lg transition-colors"
              >
                <ArrowDown size={14} /> В комментарий
              </button>
              {confirmResolve ? (
                <button
                  onClick={() => resolve.mutate(shown.draft_answer)}
                  disabled={resolve.isPending}
                  className="flex items-center justify-center gap-1.5 flex-1 bg-green-600 hover:bg-green-500 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {resolve.isPending ? 'Отправка...' : <>Точно решить? <Check size={14} /></>}
                </button>
              ) : (
                <button
                  onClick={() => setConfirmResolve(true)}
                  title="Отправить ответ клиенту и перевести заявку в «Решена»"
                  className="flex items-center justify-center gap-1.5 flex-1 bg-green-600/90 hover:bg-green-500 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors"
                >
                  <Check size={14} /> Ответить и решить
                </button>
              )}
            </div>
            {resolve.isError && (
              <p className="text-xs text-orange-400">Ошибка при отправке. Попробуйте снова.</p>
            )}
          </div>
        )
      )}
    </div>
  )
}

const VERDICT_STYLE: Record<string, string> = {
  'Глушение': 'text-warning',
  'Данные верны': 'text-green-400',
  'Не было питания': 'text-orange-400',
  'Объект не найден': 'text-red-400',
  'Нет данных': 'text-muted',
  'Нет номера/даты': 'text-muted',
  'Проверить': 'text-cyan-400',
}


function BatchAnalysis({ issueId, onUseDraft, issueTitle, onOpenExternal }: { issueId: number; onUseDraft: (text: string) => void; issueTitle?: string | null; onOpenExternal: (extId: number) => void }) {
  const queryClient = useQueryClient()
  const openTrack = useIssuesStore(s => s.openTrack)
  const batchChildren = useIssuesStore(s => s.batchChildren)
  const setBatchChild = useIssuesStore(s => s.setBatchChild)
  const clearBatchChildren = useIssuesStore(s => s.clearBatchChildren)
  const lastBatchTemplate = useIssuesStore(s => s.lastBatchTemplate)
  const setLastBatchTemplate = useIssuesStore(s => s.setLastBatchTemplate)
  const [loadingPlates, setLoadingPlates] = useState<Set<string>>(new Set())

  // Per-issue child creation map — survives panel close/reopen (global store, not local state)
  const rowCreated = batchChildren[issueId] ?? {}

  const { data: attachments = [] } = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })
  const extractable = attachments.filter(a => a.extractable)
  const isBatch = extractable.length >= 2 || (extractable.length >= 1 && /общ/i.test(issueTitle ?? ''))

  const cachedQ = useQuery({
    queryKey: ['batch-cached', issueId],
    queryFn: () => api.getCachedBatch(issueId),
    enabled: isBatch,
    staleTime: 5 * 60_000,
  })
  const cached = cachedQ.data?.cached ? cachedQ.data : null

  const run = useMutation({
    mutationFn: () => api.automateBatch(issueId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batch-cached', issueId] })
      clearBatchChildren(issueId)
    },
  })

  const createMut = useMutation({
    mutationFn: (objs: import('../types').BatchObject[]) => api.createChildren(issueId, objs),
    onSuccess: (data) => {
      for (const r of data.results) {
        if (r.plate) setBatchChild(issueId, r.plate, { issue_id: r.issue_id, ok: r.ok })
      }
      // Backend caches each child immediately — just invalidate queries
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
    },
  })

  const createRow = async (o: import('../types').BatchObject) => {
    if (!o.plate) return
    setLoadingPlates(prev => new Set([...prev, o.plate!]))
    try {
      const res = await api.createChildren(issueId, [o])
      const r = res.results[0]
      setBatchChild(issueId, o.plate, { issue_id: r?.issue_id, ok: r?.ok ?? false })
      // Backend caches child immediately — just invalidate queries
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
    } catch {
      setBatchChild(issueId, o.plate, { ok: false })
    } finally {
      setLoadingPlates(prev => { const s = new Set(prev); s.delete(o.plate!); return s })
    }
  }

  // Show only for batch issues (several extractable attachments / vehicles)
  if (!isBatch) return null

  const res = run.data ?? (cached as BatchResult | null)
  const isCached = !run.data && !!cached

  // All plates with a successfully created child issue (per-row or bulk)
  const allCreatedPlates = Object.entries(rowCreated).filter(([, v]) => v.ok).map(([plate]) => plate)

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <button
        onClick={() => run.mutate()}
        disabled={run.isPending}
        className="flex items-center justify-center gap-2 w-full bg-card border border-info/40 text-info hover:bg-info/10 text-xs font-semibold py-2 rounded-lg transition-colors disabled:opacity-50"
      >
        {run.isPending ? (
          <><Layers size={14} className="animate-pulse" /> Разбираю объекты…</>
        ) : res ? (
          <><RefreshCw size={14} /> Обновить разбор</>
        ) : (
          <><Layers size={14} /> Разбор по объектам</>
        )}
      </button>
      {isCached && (
        <p className="flex items-center gap-1 text-[10px] text-muted/70"><Database size={11} /> показан сохранённый разбор{cachedQ.data?.created_at ? ` от ${new Date(cachedQ.data.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      )}

      {res && (
        <div className="space-y-2 text-xs">
          <div className="text-[11px] text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>Всего {res.total}:</span>
            {(() => {
              const counts: Record<string, number> = {}
              for (const o of res.objects) counts[o.verdict] = (counts[o.verdict] ?? 0) + 1
              const order = ['Глушение', 'Данные верны', 'Не было питания', 'Терминал подключился', 'Изменили настройки', 'Проверить', 'Нет данных', 'Объект не найден', 'Нет номера/даты', 'Ошибка данных']
              const keys = Object.keys(counts).sort((a, b) => order.indexOf(a) - order.indexOf(b))
              return keys.map(v => (
                <span key={v} className={VERDICT_STYLE[v] ?? 'text-white'}>{v} {counts[v]}</span>
              ))
            })()}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted/60">
                <tr className="text-left">
                  <th className="py-1 pr-2">Гос.номер</th><th className="pr-2">Дата</th>
                  <th className="pr-2">ПЛ</th><th className="pr-2">Система</th><th className="pr-2">Вердикт</th><th className="pr-1"></th><th></th>
                </tr>
              </thead>
              <tbody>
                {res.objects.map((o, idx) => {
                  const rc = o.plate ? rowCreated[o.plate] : null
                  const isLoading = !!o.plate && loadingPlates.has(o.plate)
                  return (
                    <tr key={idx} className="border-t border-border/50">
                      <td className="py-1 pr-2 font-mono">{o.plate ?? '—'}</td>
                      <td className="pr-2">{o.date ?? '—'}</td>
                      <td className="pr-2">{o.sheet_mileage_km ?? '—'}</td>
                      <td className="pr-2">{o.system_mileage_km ?? '—'}</td>
                      <td className={`pr-2 ${VERDICT_STYLE[o.verdict] ?? 'text-white'}`}>{o.verdict}</td>
                      <td className="pr-1 text-center">
                        {o.plate && o.date && (
                          <button
                            onClick={() => openTrack(o.plate, o.date)}
                            title="Карта и графики этого ТС"
                            className="inline-flex text-muted hover:text-accent transition-colors"
                          ><Map size={14} /></button>
                        )}
                      </td>
                      <td className="text-center">
                        {o.plate && (
                          isLoading ? (
                            <span className="text-muted animate-pulse">…</span>
                          ) : rc?.ok && rc.issue_id ? (
                            <button
                              onClick={() => onOpenExternal(rc.issue_id!)}
                              title={`Открыть заявку #${rc.issue_id}`}
                              className="text-accent hover:underline font-mono"
                            >#{rc.issue_id}</button>
                          ) : rc?.ok ? (
                            <Check size={14} className="inline text-green-400" />
                          ) : (
                            <button
                              onClick={() => createRow(o)}
                              title="Создать дочернюю заявку"
                              className="inline-flex text-muted hover:text-accent transition-colors"
                            ><FilePlus size={14} /></button>
                          )
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(() => {
            const suffix = allCreatedPlates.length
              ? `\n\nПо ТС ${allCreatedPlates.join(', ')} оформлены отдельные заявки для индивидуального рассмотрения.`
              : ''
            return (
              <div className="flex items-center gap-2">
                <button
                  disabled={!lastBatchTemplate}
                  onClick={() => lastBatchTemplate && onUseDraft(lastBatchTemplate.content + suffix)}
                  className="flex items-center justify-center gap-1.5 flex-1 bg-accent/90 hover:bg-accent text-black text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:bg-frame disabled:text-muted disabled:border disabled:border-border"
                >
                  {lastBatchTemplate
                    ? <><ArrowDown size={14} /> {lastBatchTemplate.name} в комментарий{allCreatedPlates.length ? ' + заявки' : ''}</>
                    : <><ArrowLeft size={14} /> Выберите шаблон</>}
                </button>
                <TemplatePicker
                  onSelect={() => {}}
                  onSelectFull={setLastBatchTemplate}
                />
              </div>
            )
          })()}
          {(() => {
            const children = res.objects.filter(o => o.plate && !rowCreated[o.plate]?.ok && (o.verdict === 'Данные верны' || o.verdict === 'Нет данных'))
            const totalEligible = res.objects.filter(o => o.verdict === 'Данные верны' || o.verdict === 'Нет данных').length
            if (totalEligible === 0) return null
            return (
              <>
                <p className="flex items-start gap-1.5 text-[11px] text-muted leading-relaxed">
                  <Lightbulb size={13} className="shrink-0 mt-0.5" />
                  <span>Отдельные заявки: «данные верны» {res.objects.filter(o => o.verdict === 'Данные верны').length}{res.objects.filter(o => o.verdict === 'Нет данных').length ? `, «нет данных» ${res.objects.filter(o => o.verdict === 'Нет данных').length}` : ''} — используйте кнопку создания в строке или создайте все сразу:</span>
                </p>
                {children.length > 0 && (
                  createMut.isSuccess && children.length === 0 ? null : (
                    <button
                      onClick={() => createMut.mutate(children)}
                      disabled={createMut.isPending || children.length === 0}
                      className="flex items-center justify-center gap-1.5 w-full bg-frame border border-accent/50 text-accent hover:bg-accent/10 text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {createMut.isPending ? 'Создаю…' : <><FilePlus size={14} /> Создать все {children.length} (ещё не созданные)</>}
                    </button>
                  )
                )}
                {children.length === 0 && <p className="flex items-center gap-1.5 text-xs text-green-400"><Check size={14} /> Все дочерние заявки созданы</p>}
                {createMut.isError && <p className="text-xs text-orange-400">Ошибка создания. Попробуйте снова.</p>}
              </>
            )
          })()}
        </div>
      )}
      {run.isError && <p className="text-xs text-orange-400">Ошибка разбора. Попробуйте снова.</p>}
    </div>
  )
}

const KIND_ICON: Record<string, LucideIcon> = {
  pdf: FileText, word: FileText, excel: Sheet, image: ImageIcon, text: FileText, other: Paperclip,
}

function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function AttachmentsSection({ issueId }: { issueId: number }) {
  const { data: items = [] } = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })

  if (items.length === 0) return null

  return (
    <Block icon={Paperclip} title="Вложения" count={items.length}>
      <div className="space-y-1.5">
        {items.map(a => {
          const KI = KIND_ICON[a.kind] ?? Paperclip
          return (
            <a
              key={a.id}
              href={api.attachmentUrl(issueId, a.id)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2.5 bg-frame hover:bg-white/5 border border-border rounded-lg px-3 py-2 transition-colors group"
            >
              <KI size={18} className="shrink-0 text-muted" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-white group-hover:text-accent truncate">{a.name ?? `#${a.id}`}</div>
                <div className="text-[10px] text-muted flex items-center gap-1.5">
                  {formatSize(a.size)}
                  {a.extractable && <span className="inline-flex items-center gap-1 text-green-400/80">· <Sparkles size={10} /> ИИ читает</span>}
                  {!a.extractable && a.kind === 'image' && <span className="text-warning/70">· скан (OCR недоступен)</span>}
                </div>
              </div>
              <ExternalLink size={14} className="text-muted/50 shrink-0" />
            </a>
          )
        })}
      </div>
    </Block>
  )
}

export function IssueDetail() {
  const { selectedIssueId, selectIssue, trackOpen, setTrackOpen, openTrack, lastTemplate } = useIssuesStore()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [commentPublic, setCommentPublic] = useState(true)
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<typeof ALL_STATUSES[number] | null>(null)
  const [resolveNotice, setResolveNotice] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(id)
  }, [toast])

  // On opening a new issue, prefill the comment with the last-used template
  // (until the operator picks another). Empty if none chosen yet.
  // Open a related (parent/child) issue by its Okdesk external id → resolve to
  // internal cache id and select it.
  const openExternal = async (extId: number) => {
    try {
      const res = await api.listIssues({ issue_id: extId, limit: 1 })
      if (res.data[0]) selectIssue(res.data[0].id)
      else setToast(`Заявка #${extId} не найдена в кэше`)
    } catch {
      setToast(`Не удалось открыть #${extId}`)
    }
  }

  useEffect(() => {
    setComment(lastTemplate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIssueId])

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
    mutationFn: (text: string) => api.addComment(selectedIssueId!, text, commentPublic),
    onSuccess: () => {
      setComment('')
      queryClient.invalidateQueries({ queryKey: ['comments', selectedIssueId] })
    },
  })

  const quickResolve = useMutation({
    mutationFn: (statusCode: 'completed' | 'delayed') => {
      const delayTo = statusCode === 'delayed'
        ? (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 16) })()
        : undefined
      return api.resolveIssue(selectedIssueId!, statusCode, comment, delayTo, commentPublic)
    },
    onSuccess: (data) => {
      setComment('')
      queryClient.invalidateQueries({ queryKey: ['issue', selectedIssueId] })
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['comments', selectedIssueId] })
      if (!data.status_changed) setResolveNotice('Статус не изменён — смените вручную в Okdesk.')
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
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0 sticky top-0 bg-base z-20">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-muted text-xs font-mono">#{issue.external_id}</span>
            {od ? (
              <div className="relative">
                <button
                  onClick={() => setStatusDropdownOpen(v => !v)}
                  title="Изменить статус"
                  className="hover:opacity-75 transition-opacity"
                >
                  <StatusBadge status={issue.status} />
                </button>
                {statusDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setStatusDropdownOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-lg overflow-hidden shadow-lg border border-border min-w-[160px]">
                      {getAvailableStatuses(issue.status, od.type_code).map(s => (
                        <button
                          key={s.code}
                          onClick={() => { setStatusDropdownOpen(false); setPendingStatus(s) }}
                          className="w-full text-left px-4 py-2.5 text-xs font-medium text-white hover:brightness-110 transition-all"
                          style={{ background: s.bg }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <StatusBadge status={issue.status} />
            )}
            {issue.priority && <span className="text-xs text-muted">{issue.priority}</span>}
          </div>
          <h2 className="text-sm font-semibold leading-snug">{issue.subject ?? '—'}</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => trackOpen ? setTrackOpen(false) : openTrack()}
            title="Карта трека и графики телеметрии"
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${trackOpen ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:text-white hover:border-accent'}`}
          >
            {trackOpen ? <><PanelRightClose size={14} /> Скрыть</> : <><Map size={14} /> Карта и графики</>}
          </button>
          <button onClick={() => selectIssue(null)} className="text-muted hover:text-white"><X size={18} /></button>
        </div>
      </div>

      <div className="flex-1 px-5 py-4 space-y-6">
        {resolveNotice && (
          <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="flex-1">{resolveNotice}</span>
            <button onClick={() => setResolveNotice(null)} className="shrink-0 text-warning/60 hover:text-warning"><X size={14} /></button>
          </div>
        )}

        {/* ── 1. Детали заявки ─────────────────────────────────── */}
        <Block icon={Info} title="Детали заявки">
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
          {od && <div className="mt-4"><OkdeskInfo d={od} issueId={issue.id} assigneeName={issue.assignee_name ?? null} onOpenExternal={openExternal} /></div>}

          {/* Если okdesk_detail пустой — показываем только assignee picker */}
          {!od && (
            <div className="mt-4"><AssigneeSection issueId={issue.id} assigneeName={issue.assignee_name ?? null} /></div>
          )}
        </Block>

        {/* ── 2. Вложения (перед анализом — ИИ читает их) ───────── */}
        <AttachmentsSection issueId={issue.id} />

        {/* ── 3. Анализ ────────────────────────────────────────── */}
        <Block icon={Sparkles} title="Анализ пробега">
          <div className="border border-border rounded-xl p-4 space-y-3">
            <AutoAnalysis
              issueId={issue.id}
              onUseDraft={(text) => { setComment(text); setCommentPublic(true) }}
              latestAnalysis={latest_analysis}
              issueTitle={issue.subject}
            />

            <BatchAnalysis
              issueId={issue.id}
              onUseDraft={(text) => { setComment(text); setCommentPublic(true) }}
              issueTitle={issue.subject}
              onOpenExternal={openExternal}
            />
          </div>
        </Block>

        {/* ── 4. Комментарии ───────────────────────────────────── */}
        <Block icon={MessageSquare} title="Комментарии" count={comments.length > 0 ? comments.length : null}>
          <div className="space-y-2">
            {comments.map(c => (
              <div key={c.id} className="bg-frame rounded-lg px-3 py-2.5 text-xs space-y-0.5">
                <div className="flex items-center justify-between text-muted">
                  <span className="font-medium text-white/70">{c.author}</span>
                  <span>{formatDate(c.created_at)}</span>
                </div>
                <p className="leading-relaxed">{c.content ?? ''}</p>
              </div>
            ))}
            {comments.length === 0 && <p className="text-xs text-muted">Комментариев нет</p>}
          </div>

          <div className="space-y-2 mt-3">
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
                className="flex-1 bg-frame border border-border rounded-lg px-3 py-1.5 text-xs resize-none focus:outline-none focus:border-accent"
              />
              <div className="flex flex-col gap-1.5 shrink-0">
                <TemplatePicker onSelect={text => setComment(text)} />
                <button
                  disabled={!comment || addComment.isPending}
                  onClick={() => addComment.mutate(comment)}
                  title="Отправить (Ctrl+Enter)"
                  className="flex items-center justify-center bg-frame border border-border hover:border-accent rounded-lg px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40 text-muted hover:text-accent"
                >
                  {addComment.isPending ? '...' : <Send size={15} />}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={commentPublic}
                  onChange={e => setCommentPublic(e.target.checked)}
                  className="w-3 h-3 accent-accent"
                />
                <span className={`text-[10px] ${commentPublic ? 'text-white' : 'text-muted'}`}>
                  {commentPublic ? 'Публичный' : 'Приватный'}
                </span>
              </label>
              {comment && <p className="text-[10px] text-muted">Ctrl+Enter — отправить</p>}
            </div>

            {/* Быстрое решение: комментарий + смена статуса одним кликом */}
            <div className="flex items-center gap-2">
              <button
                disabled={!comment || quickResolve.isPending}
                onClick={() => quickResolve.mutate('delayed')}
                title="Отправить ответ и перевести в «Ожидание ответа» (+3 дня)"
                className="flex items-center justify-center gap-1.5 flex-1 bg-frame border border-border hover:border-accent text-white text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-40"
              >
                {quickResolve.isPending && quickResolve.variables === 'delayed' ? '...' : <><Pause size={14} /> Ожидание</>}
              </button>
              <button
                disabled={!comment || quickResolve.isPending}
                onClick={() => {
                  if (!od?.type_code || od.type_code === 'inner') {
                    setToast('Сначала укажите тип заявки')
                    return
                  }
                  quickResolve.mutate('completed')
                }}
                title="Отправить ответ клиенту и перевести в «Решена»"
                className="flex items-center justify-center gap-1.5 flex-1 bg-green-600/90 hover:bg-green-500 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-40"
              >
                {quickResolve.isPending && quickResolve.variables === 'completed' ? 'Отправка...' : <><Check size={14} /> Решить</>}
              </button>
            </div>
          </div>
        </Block>
      </div>
    </div>

    {pendingStatus && od && (
      <StatusActionModal
        issueId={issue.id}
        externalId={issue.external_id}
        targetStatus={pendingStatus}
        onClose={() => setPendingStatus(null)}
        onDone={(notice) => { setPendingStatus(null); if (notice) setResolveNotice(notice) }}
      />
    )}

    {toast && (
      <div className="fixed bottom-5 right-5 z-[60] flex items-center gap-2 bg-warning text-black text-xs font-semibold px-4 py-2.5 rounded-lg shadow-lg">
        <AlertTriangle size={14} /> {toast}
      </div>
    )}
    </>
  )
}
