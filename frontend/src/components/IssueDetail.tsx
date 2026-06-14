import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useUserStore, EMPLOYEES } from '../store/userStore'
import { StatusBadge } from './StatusBadge'
import type { OkdeskDetail, Template, AutomationResult } from '../types'

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

function TypeSection({ issueId, typeName, typeCode }: { issueId: number; typeName: string | null; typeCode: string | null }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data: types = [] } = useQuery({
    queryKey: ['issue-types'],
    queryFn: () => api.listIssueTypes(),
    staleTime: 5 * 60 * 1000,
  })

  const mutation = useMutation({
    mutationFn: (code: string) => api.changeIssueType(issueId, code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      setOpen(false)
    },
  })

  const isDefault = !typeCode || typeCode === 'inner'

  return (
    <div className="col-span-2 flex items-center gap-2">
      <span className="text-muted shrink-0">Тип</span>
      {open ? (
        <div className="flex items-center gap-1.5 flex-1">
          <select
            autoFocus
            className="flex-1 bg-surface border border-border rounded px-2 py-0.5 text-xs text-white"
            defaultValue={typeCode ?? ''}
            onChange={e => e.target.value && mutation.mutate(e.target.value)}
            onBlur={() => setOpen(false)}
          >
            <option value="" disabled>Выберите тип...</option>
            {types.map(t => (
              <option key={t.code} value={t.code}>{t.name}</option>
            ))}
          </select>
          <button onClick={() => setOpen(false)} className="text-muted hover:text-white leading-none">✕</button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className={`text-left hover:text-white transition-colors ${isDefault ? 'text-yellow-400' : 'text-white'}`}
        >
          {isDefault ? '⚠ Не указан — нажмите чтобы выбрать' : typeName}
        </button>
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
      <div className="relative bg-surface border border-border rounded-xl w-full max-w-md shadow-2xl z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: targetStatus.bg }} />
            <h2 className="text-sm font-semibold">{targetStatus.label} — #{externalId}</h2>
          </div>
          <button onClick={onClose} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {targetStatus.needsDelay && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">
                Отложить до <span className="text-red-400">*</span>
              </p>
              <input
                type="datetime-local"
                value={delayTo}
                onChange={e => setDelayTo(e.target.value)}
                className="w-full bg-base border border-border rounded px-3 py-2 text-xs focus:outline-none focus:border-accent"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">
              Комментарий{targetStatus.commentRequired && <span className="text-red-400 ml-1">*</span>}
            </p>
            <div className="flex items-start gap-2">
              <textarea
                autoFocus
                placeholder={targetStatus.commentRequired ? 'Обязательный комментарий...' : 'Необязательный комментарий...'}
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={4}
                className="flex-1 bg-base border border-border rounded px-3 py-2 text-xs resize-none focus:outline-none focus:border-accent leading-relaxed"
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
            className="px-4 py-2 rounded-lg text-white text-xs font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-surface disabled:border disabled:border-border"
          >
            {mutation.isPending ? <span className="animate-pulse">Отправка...</span> : `✓ ${targetStatus.label}`}
          </button>
        </div>

        {mutation.isError && (
          <p className="px-5 pb-4 text-xs text-red-400">Ошибка при отправке. Попробуйте снова.</p>
        )}
      </div>
    </div>
  )
}

const FLAG_LABELS: Record<string, string> = {
  power_off: '🔌 Нет питания',
  jamming: '📡 Глушение GPS',
  track_gap: '✂ Обрыв трека',
  no_data: '⚠ Нет данных',
  object_not_found: '❓ Объект не найден',
}

function Fact({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  if (value == null || value === '') return null
  return (
    <>
      <span className="text-muted">{label}</span>
      <span className={warn ? 'text-yellow-400' : ''}>{value}</span>
    </>
  )
}

function AutoAnalysis({ issueId, onUseDraft }: { issueId: number; onUseDraft: (text: string) => void }) {
  const queryClient = useQueryClient()
  const [result, setResult] = useState<AutomationResult | null>(null)
  const [confirmResolve, setConfirmResolve] = useState(false)

  const run = useMutation({
    mutationFn: () => api.automateIssue(issueId),
    onSuccess: (data) => {
      setResult(data)
      setConfirmResolve(false)
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
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

  const t = result?.telemetry
  const p = result?.parsed
  const conf = result ? Math.round(result.confidence * 100) : 0

  return (
    <div className="space-y-3">
      <button
        onClick={() => run.mutate()}
        disabled={run.isPending}
        className="w-full bg-gradient-to-r from-violet-600/90 to-fuchsia-600/90 hover:from-violet-600 hover:to-fuchsia-600 text-white text-xs font-semibold py-2 rounded transition-colors disabled:opacity-50"
      >
        {run.isPending ? '🤖 Анализирую заявку и данные geo...' : '🤖 Автоанализ заявки'}
      </button>

      {run.isError && (
        <p className="text-xs text-red-400">Ошибка анализа. Попробуйте снова.</p>
      )}

      {result && (
        <div className="space-y-2.5 text-xs">
          {result.error && (
            <p className="text-yellow-400">⚠ {result.reasoning}</p>
          )}

          {t && (t.object_name || t.system_mileage_km != null) && (
            <div className="bg-base rounded-lg px-3 py-2.5 space-y-2">
              {t.flags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.flags.map(f => (
                    <span key={f} className="px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300 text-[10px]">
                      {FLAG_LABELS[f] ?? f}
                    </span>
                  ))}
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

          {result.draft_answer && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-accent/15 text-accent text-[10px] font-semibold">{result.category}</span>
                <span className={`text-[10px] ${result.needs_review ? 'text-yellow-400' : 'text-green-400'}`}>
                  уверенность {conf}%{result.needs_review ? ' · нужна проверка' : ''}
                </span>
              </div>
              <p className="text-white/90 leading-relaxed bg-surface rounded-lg px-3 py-2.5 whitespace-pre-wrap">
                {result.draft_answer}
              </p>
              {result.reasoning && !result.error && (
                <p className="text-muted leading-relaxed text-[11px]">💡 {result.reasoning}</p>
              )}
              {resolve.isSuccess ? (
                <p className="text-xs text-green-400 text-center py-1.5">✓ Заявка решена, ответ отправлен клиенту</p>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => onUseDraft(result.draft_answer)}
                    className="flex-1 bg-surface border border-border hover:border-accent text-white text-xs font-semibold py-1.5 rounded transition-colors"
                  >
                    ↓ В комментарий
                  </button>
                  {confirmResolve ? (
                    <button
                      onClick={() => resolve.mutate(result.draft_answer)}
                      disabled={resolve.isPending}
                      className="flex-1 bg-green-600 hover:bg-green-500 text-white text-xs font-semibold py-1.5 rounded transition-colors disabled:opacity-50"
                    >
                      {resolve.isPending ? 'Отправка...' : 'Точно решить? ✓'}
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmResolve(true)}
                      title="Отправить ответ клиенту и перевести заявку в «Решена»"
                      className="flex-1 bg-green-600/90 hover:bg-green-500 text-white text-xs font-semibold py-1.5 rounded transition-colors"
                    >
                      ✓ Ответить и решить
                    </button>
                  )}
                </div>
              )}
              {resolve.isError && (
                <p className="text-xs text-red-400">Ошибка при отправке. Попробуйте снова.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function IssueDetail() {
  const { selectedIssueId, selectIssue, trackOpen, setTrackOpen } = useIssuesStore()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [commentPublic, setCommentPublic] = useState(true)
  const [mileage, setMileage] = useState('')
  const [notes, setNotes] = useState('')
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<typeof ALL_STATUSES[number] | null>(null)
  const [resolveNotice, setResolveNotice] = useState<string | null>(null)

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
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-lg overflow-hidden shadow-2xl border border-border min-w-[160px]">
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
            onClick={() => setTrackOpen(!trackOpen)}
            title="Карта трека и графики телеметрии"
            className={`text-xs px-2.5 py-1 rounded border transition-colors ${trackOpen ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:text-white hover:border-accent'}`}
          >
            {trackOpen ? '◀ Скрыть' : '🗺 Карта и графики'}
          </button>
          <button onClick={() => selectIssue(null)} className="text-muted hover:text-white text-lg leading-none">✕</button>
        </div>
      </div>

      <div className="flex-1 px-5 py-4 space-y-5">
        {resolveNotice && (
          <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-xs text-yellow-300">
            <span className="shrink-0 mt-0.5">⚠</span>
            <span className="flex-1">{resolveNotice}</span>
            <button onClick={() => setResolveNotice(null)} className="shrink-0 text-yellow-400/60 hover:text-yellow-300 leading-none">✕</button>
          </div>
        )}
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

          <AutoAnalysis issueId={issue.id} onUseDraft={(text) => { setComment(text); setCommentPublic(true) }} />

          <div className="pt-2 border-t border-border" />

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
                className="flex-1 bg-surface border border-border hover:border-accent text-white text-xs font-semibold py-1.5 rounded transition-colors disabled:opacity-40"
              >
                {quickResolve.isPending && quickResolve.variables === 'delayed' ? '...' : '⏸ Ожидание'}
              </button>
              <button
                disabled={!comment || quickResolve.isPending}
                onClick={() => quickResolve.mutate('completed')}
                title="Отправить ответ клиенту и перевести в «Решена»"
                className="flex-1 bg-green-600/90 hover:bg-green-500 text-white text-xs font-semibold py-1.5 rounded transition-colors disabled:opacity-40"
              >
                {quickResolve.isPending && quickResolve.variables === 'completed' ? 'Отправка...' : '✓ Решить'}
              </button>
            </div>
          </div>
        </div>
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
    </>
  )
}
