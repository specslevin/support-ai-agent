import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo, useEffect, useRef } from 'react'
import {
  ChevronDown, ChevronUp, AlertTriangle, X, Check, Star, Bot, RefreshCw, Database,
  Lightbulb, Map, FilePlus, ExternalLink, Pause, Send,
  Layers, FileText, Sheet,
  Image as ImageIcon, Paperclip, PanelRightClose, Info, MessageSquare, Sparkles, Wand2,
  Maximize2, Minimize2,
  Loader2, Lock, User, Headset, Play, ThumbsUp, ThumbsDown,
  Copy, Calendar, Truck, Pencil,
  type LucideIcon,
} from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useUserStore } from '../store/userStore'
import { useAuthStore } from '../store/authStore'
import { StatusBadge } from './StatusBadge'
import { EmployeeMenu, TypeMenu } from './pickers'
import type { OkdeskDetail, Template, AutomationResult, BatchResult } from '../types'
import { extractPlaceholders, hasPlaceholders, renderTemplate, computedPlaceholderValue } from '../lib/templates'
import { STATUS_COLOR, statusPillStyle } from '../lib/status'
import { TelemetryPanel } from './TelemetryPanel'

function formatDate(iso: string | null | undefined) {
  if (!iso) return null
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/** Небольшой единообразный индикатор «ИИ работает»: спиннер + подпись. */
function Working({ label, className = '' }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Loader2 size={14} className="animate-spin" />
      {label}
    </span>
  )
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

function Section({ title, children, defaultOpen = true }: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(v => !v)}
        title={open ? `Свернуть «${title}»` : `Раскрыть «${title}»`}
        className="flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-muted/60 hover:text-muted transition-colors"
      >
        {open ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
        {title}
      </button>
      {open && children}
    </div>
  )
}

/**
 * Верхнеуровневый блок карточки заявки (макет v3): самостоятельная карточка
 * с заголовком 15/Bold, счётчиком-пилюлей и слотом справа для мета-текста
 * или действия блока. Иконка опциональна — в v3 заголовки монохромные, иконку
 * оставляем только там, где она несёт смысл.
 */
function Block({ icon: Icon, title, count, right, children }: {
  icon?: LucideIcon
  title: string
  count?: number | null
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-card rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={14} className="text-accent shrink-0" />}
        <h3 className="text-[15px] font-bold leading-[18px] text-white">{title}</h3>
        {count != null && (
          <span className="bg-frame rounded-pill px-2 py-0.5 text-[11px] font-medium text-secondary tabular-nums">{count}</span>
        )}
        {right && <div className="ml-auto min-w-0">{right}</div>}
      </div>
      {children}
    </section>
  )
}

/** Копирование текста с фоллбэком для незащищённого контекста (app по HTTP). */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text))
  }
  fallbackCopyText(text)
  return Promise.resolve()
}

function fallbackCopyText(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch { /* ignore */ }
  document.body.removeChild(ta)
}

/** «Передать монтажнику»: два формата (КАЛЕНДАРЬ / МЕССЕНДЖЕР) в один клик. */
function InstallerExportSection({ issueId }: { issueId: number }) {
  const [copied, setCopied] = useState<'calendar' | 'messenger' | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  // isFetching, а НЕ isPending: у query с enabled:false статус всегда 'pending'
  // (данных ещё нет), из-за чего спиннер «Собираю…» висел вечно. isFetching=true
  // только во время фактической загрузки по кнопке.
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['installer-export', issueId],
    queryFn: () => api.installerExport(issueId),
    enabled: false, // загружаем лениво — только когда оператору это нужно
  })

  const ensure = async () => {
    if (data) return data
    const res = await refetch()
    return res.data
  }

  const handleCopy = async (kind: 'calendar' | 'messenger') => {
    const d = await ensure()
    if (!d) return
    await copyToClipboard(kind === 'calendar' ? d.calendar : d.messenger)
    setShowPreview(true)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1800)
  }

  return (
    <Block icon={Truck} title="Передать монтажнику">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleCopy('calendar')}
            disabled={isFetching}
            title={copied === 'calendar' ? 'Скопировано' : 'Скопировать текст для календаря'}
            className="flex items-center justify-center bg-frame border border-border hover:border-accent rounded-md p-1.5 text-muted hover:text-accent transition-colors disabled:opacity-50"
          >
            {copied === 'calendar' ? <Check size={15} className="text-success" /> : <Calendar size={15} />}
          </button>
          <button
            onClick={() => handleCopy('messenger')}
            disabled={isFetching}
            title={copied === 'messenger' ? 'Скопировано' : 'Скопировать текст для мессенджера'}
            className="flex items-center justify-center bg-frame border border-border hover:border-accent rounded-md p-1.5 text-muted hover:text-accent transition-colors disabled:opacity-50"
          >
            {copied === 'messenger' ? <Check size={15} className="text-success" /> : <MessageSquare size={15} />}
          </button>
          {isFetching && <Working label="Собираю…" className="text-muted" />}
        </div>

        {isError && (
          <p className="text-[11px] text-red-400">Не удалось собрать данные. Попробуйте ещё раз.</p>
        )}

        {data && (
          <>
            <button
              onClick={() => setShowPreview(v => !v)}
              className="flex items-center gap-1 text-[11px] text-muted hover:text-accent transition-colors"
            >
              <ChevronDown size={12} className={`transition-transform ${showPreview ? 'rotate-180' : ''}`} />
              {showPreview ? 'Скрыть предпросмотр' : 'Показать предпросмотр'}
            </button>
            {showPreview && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <PreviewCard icon={Calendar} title="Календарь" text={data.calendar} onCopy={() => handleCopy('calendar')} />
                <PreviewCard icon={Send} title="Мессенджер" text={data.messenger} onCopy={() => handleCopy('messenger')} />
              </div>
            )}
            <p className="text-[10px] text-muted/70">
              Прочерки «____» — поля не найдены в заявке, дозаполните вручную перед отправкой.
            </p>
          </>
        )}
      </div>
    </Block>
  )
}

function PreviewCard({ icon: Icon, title, text, onCopy }: {
  icon: LucideIcon; title: string; text: string; onCopy: () => void
}) {
  return (
    <div className="rounded-md border border-border bg-frame p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        <Icon size={11} className="text-accent" />
        <span>{title}</span>
        <button onClick={onCopy} title="Копировать" className="ml-auto text-muted hover:text-accent transition-colors">
          <Copy size={12} />
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/80 font-sans">{text}</pre>
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
          className="text-[10px] px-2 py-0.5 rounded-md border border-accent/50 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 shrink-0"
        >
          Взять себе
        </button>
      )}

      <div className="relative shrink-0">
        <button
          onClick={() => setPickerOpen(o => !o)}
          disabled={assignMutation.isPending}
          className="flex items-center px-1.5 py-0.5 rounded-md border border-border hover:border-accent text-muted hover:text-white transition-colors disabled:opacity-40"
        >
          <ChevronDown size={13} />
        </button>

        {pickerOpen && (
          <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-md py-1 z-50 w-40 shadow-lg">
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
          <div className="absolute left-10 top-full mt-1 z-50 bg-card border border-border rounded-md py-1 min-w-[200px] max-h-72 overflow-y-auto shadow-lg">
            <TypeMenu selectedCode={typeCode} onPick={t => { mutation.mutate(t.code); setOpen(false) }} />
          </div>
        </>
      )}
    </div>
  )
}

// Редактируемые кастом-параметры заявки. Okdesk требует их заполненными для
// перевода заявки в статус «В работе» (баг 64197). Сопоставляем по имени
// параметра, т.к. фронту приходят только {name, value}.
const EDITABLE_PARAMS: { code: 'address' | 'contact_person' | 'tel_person'; label: string; match: RegExp }[] = [
  { code: 'address', label: 'Местоположение техники', match: /местоположен|адрес/i },
  { code: 'contact_person', label: 'Контактное лицо', match: /контактн|ответственн/i },
  { code: 'tel_person', label: 'Номер телефона', match: /телефон|тел\b|моб/i },
]

function EditableParameters({ d, issueId }: { d: OkdeskDetail; issueId: number }) {
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const queryClient = useQueryClient()

  const initial = useMemo(() => {
    const out: Record<string, string> = { address: '', contact_person: '', tel_person: '' }
    for (const ep of EDITABLE_PARAMS) {
      const hit = d.parameters.find(p => ep.match.test(p.name))
      out[ep.code] = hit?.value ?? ''
    }
    return out
  }, [d.parameters])

  const [vals, setVals] = useState<Record<string, string>>(initial)
  useEffect(() => { setVals(initial) }, [initial])

  const dirty = EDITABLE_PARAMS.some(ep => (vals[ep.code] ?? '') !== (initial[ep.code] ?? ''))

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, string> = {}
      for (const ep of EDITABLE_PARAMS) {
        if ((vals[ep.code] ?? '') !== (initial[ep.code] ?? '')) payload[ep.code] = vals[ep.code] ?? ''
      }
      return api.updateIssueParameters(issueId, payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
    },
  })

  // Параметры, которые не входят в редактируемую тройку — показываем как есть.
  const otherParams = d.parameters.filter(p => !EDITABLE_PARAMS.some(ep => ep.match.test(p.name)))

  return (
    <Section title="Параметры заявки" defaultOpen={false}>
      <div className="space-y-2">
        {EDITABLE_PARAMS.map(ep => (
          <div key={ep.code} className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-1">
            <span className="text-muted">{ep.label}</span>
            <input
              type="text"
              value={vals[ep.code] ?? ''}
              onChange={e => setVals(v => ({ ...v, [ep.code]: e.target.value }))}
              disabled={isDemo || mutation.isPending}
              placeholder="—"
              className="bg-frame border border-border rounded-md px-2 py-1 text-xs text-white placeholder:text-muted/50 focus:border-accent outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
        ))}
        {otherParams.length > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1">
            {otherParams.map(p => (
              <MetaRow key={p.name} label={p.name}>{p.value}</MetaRow>
            ))}
          </div>
        )}
      </div>
      {mutation.isError && (
        <p className="text-danger text-[11px]">
          {(mutation.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Не удалось сохранить параметры'}
        </p>
      )}
      <button
        onClick={() => mutation.mutate()}
        disabled={isDemo || mutation.isPending || !dirty}
        title={isDemo ? 'Недоступно в демо-режиме' : 'Сохранить параметры в Okdesk'}
        className={`flex items-center justify-center gap-1.5 w-full bg-card border border-border hover:border-accent text-xs font-semibold py-1.5 rounded-md transition-colors disabled:opacity-40 text-muted hover:text-accent ${mutation.isPending ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
      >
        {mutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        {mutation.isPending ? 'Сохраняю…' : 'Сохранить параметры'}
      </button>
    </Section>
  )
}

// Связанные заявки отсюда вынесены в RelatedIssuesSection (блок рельса v3),
// поэтому onOpenExternal этому компоненту больше не нужен.
function OkdeskInfo({ d, issueId, assigneeName }: { d: OkdeskDetail; issueId: number; assigneeName: string | null }) {
  const deadline = formatDate(d.deadline_at)
  const overdue = isOverdue(d.deadline_at)

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
      <Section title="Сроки" defaultOpen={false}>
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

      {/* Параметры заявки (редактируемые custom fields) */}
      <EditableParameters d={d} issueId={issueId} />

    </div>
  )
}

/**
 * Вопрос клиента — первый блок рабочей колонки. Раньше лежал внутри «Деталей
 * заявки», то есть в рельсе на ~360px: длинное письмо там читать неудобно.
 * Это исходный материал работы, а не свойство заявки, поэтому он слева и
 * первым — до разбора ИИ.
 */
function ClientQuestionBlock({ description }: { description: string | null | undefined }) {
  const text = stripHtml(description)
  // Раскрыт по умолчанию: письмо клиента — первое, что читает оператор. Свернуть
  // нужно, когда работа уже идёт по разбору и письмо только занимает место;
  // в свёрнутом виде оставляем peek первой строки, чтобы блок не был пустым.
  const [open, setOpen] = useState(true)
  return (
    <Block
      title="Вопрос клиента"
      right={
        <button
          onClick={() => setOpen(v => !v)}
          title={open ? 'Свернуть вопрос клиента' : 'Показать вопрос клиента полностью'}
          className="flex items-center gap-1 text-xs text-muted hover:text-white transition-colors"
        >
          {open ? <><ChevronUp size={13} /> Свернуть</> : <><ChevronDown size={13} /> Раскрыть</>}
        </button>
      }
    >
      {open ? (
        <p className="text-[13px] leading-5 text-white/80 whitespace-pre-wrap bg-frame rounded-md px-3 py-2.5">
          {text || <span className="text-muted/60">Текст отсутствует — см. тему и параметры заявки</span>}
        </p>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="w-full text-left text-[13px] leading-5 text-muted truncate hover:text-white/80 transition-colors"
        >
          {text || 'Текст отсутствует — см. тему и параметры заявки'}
        </button>
      )}
    </Block>
  )
}

/**
 * Связанные заявки — отдельный блок правого рельса (v3). Раньше жил внутри
 * «Деталей заявки»; вынесен, потому что это навигация, а не свойства заявки.
 * Номер — белый (данные), кликабельность показываем подчёркиванием на ховере:
 * лаймовый цвет в v3 зарезервирован за действиями.
 */
function RelatedIssuesSection({ d, onOpenExternal }: { d: OkdeskDetail; onOpenExternal: (extId: number) => void }) {
  const total = (d.parent_id ? 1 : 0) + d.child_ids.length
  if (total === 0) return null
  return (
    <Block title="Связанные заявки" count={total}>
      <div className="space-y-2">
        {d.parent_id && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted">Родительская</p>
            <button
              onClick={() => onOpenExternal(d.parent_id!)}
              className="w-full flex items-center gap-2 bg-frame rounded-md px-2.5 py-2 text-xs text-white hover:underline text-left"
            >
              №{d.parent_id}
            </button>
          </div>
        )}
        {d.child_ids.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted">Дочерние ({d.child_ids.length})</p>
            {d.child_ids.map(id => (
              <button
                key={id}
                onClick={() => onOpenExternal(id)}
                className="w-full flex items-center gap-2 bg-frame rounded-md px-2.5 py-2 text-xs text-white hover:underline text-left"
              >
                №{id}
              </button>
            ))}
          </div>
        )}
      </div>
    </Block>
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

export function TemplatePicker({ onSelect, onSelectFull, issueId }: { onSelect: (content: string) => void; onSelectFull?: (t: { name: string; content: string }) => void; issueId?: number }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  // Fill step for dynamic templates: holds the chosen template + per-placeholder values.
  const [fill, setFill] = useState<{ tpl: Template; values: Record<string, string> } | null>(null)
  const setLastTemplate = useIssuesStore(s => s.setLastTemplate)

  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.listTemplates(),
    staleTime: 5 * 60_000,
  })

  // Этап 2: suggested placeholder values from the cached analysis (telemetry/track).
  // Only fetched when the picker is bound to a concrete issue and is open — bulk
  // usages (no issueId) skip this entirely and keep the empty/today behavior.
  const { data: suggested } = useQuery({
    queryKey: ['template-values', issueId],
    queryFn: () => api.templateValues(issueId as number),
    enabled: open && typeof issueId === 'number',
    staleTime: 60_000,
  })

  // Bump usage_count server-side (fire-and-forget; non-blocking, ignores errors).
  const bumpUsage = (id: number | undefined) => {
    if (typeof id !== 'number') return
    api.incrementTemplateUsage(id).catch(() => {})
  }

  // Emit the final content (already substituted) through the existing callbacks.
  const emit = (tpl: Template, content: string) => {
    bumpUsage(tpl.id)
    setLastTemplate(content)
    if (onSelectFull) {
      onSelectFull({ name: tpl.name, content })
    } else {
      onSelect(content)
    }
    setOpen(false)
    setSearch('')
    setFill(null)
  }

  const handleSelect = (t: Template) => {
    if (hasPlaceholders(t.content)) {
      // Case-insensitive lookup over suggested values from the cached analysis.
      const sugg = suggested?.values ?? {}
      const suggLower: Record<string, string> = {}
      for (const [k, v] of Object.entries(sugg)) suggLower[k.toLowerCase()] = v
      const init: Record<string, string> = {}
      for (const name of extractPlaceholders(t.content)) {
        const computed = computedPlaceholderValue(name)
        if (computed !== null) {
          init[name] = computed
        } else {
          const hit = suggLower[name.trim().toLowerCase()]
          init[name] = hit ?? ''
        }
      }
      setFill({ tpl: t, values: init })
      return
    }
    emit(t, t.content)
  }

  // Distinct category names present (for the optional filter dropdown).
  const categoryNames = useMemo(() => {
    const set = new Set<string>()
    for (const t of templates) if (t.category_name) set.add(t.category_name)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [templates])

  // Flat list: optional text search + optional category filter, favorites first
  // then usage_count desc. No mandatory category grouping.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return templates
      .filter(t => {
        if (catFilter && t.category_name !== catFilter) return false
        if (!q) return true
        return (
          t.name.toLowerCase().includes(q) ||
          t.content.toLowerCase().includes(q)
        )
      })
      .sort(
        (a, b) =>
          Number(b.is_favorite) - Number(a.is_favorite) ||
          b.usage_count - a.usage_count,
      )
  }, [templates, search, catFilter])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Шаблоны ответов"
        className="flex items-center justify-center shrink-0 px-2.5 py-1.5 bg-frame border border-border hover:border-accent rounded-md transition-colors text-muted hover:text-accent"
      >
        <FileText size={15} />
      </button>
    )
  }

  // Fill step: prompt for one value per unique placeholder, live preview.
  if (fill) {
    const names = extractPlaceholders(fill.tpl.content)
    const preview = renderTemplate(fill.tpl.content, fill.values)
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
        <div className="fixed inset-0 bg-black/60" onClick={() => setFill(null)} />
        <div className="relative bg-card border border-border rounded-xl w-full max-w-md max-h-[80vh] flex flex-col shadow-lg z-10">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <span className="text-sm font-semibold flex items-center gap-1.5">
              <Wand2 size={14} className="text-accent" /> {fill.tpl.name}
            </span>
            <button onClick={() => setFill(null)} className="text-muted hover:text-white"><X size={18} /></button>
          </div>
          <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
            {names.map(name => (
              <div key={name}>
                <label className="block text-[11px] text-muted mb-1">{name}</label>
                <input
                  autoFocus={name === names[0]}
                  type="text"
                  value={fill.values[name] ?? ''}
                  onChange={e =>
                    setFill(f => f && { ...f, values: { ...f.values, [name]: e.target.value } })
                  }
                  placeholder={`[${name}]`}
                  className="w-full bg-frame border border-border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
                />
              </div>
            ))}
            <div>
              <span className="block text-[10px] uppercase tracking-widest text-muted mb-1">Предпросмотр</span>
              <p className="text-[11px] text-white whitespace-pre-wrap bg-frame border border-border rounded-md px-3 py-2 leading-relaxed">{preview}</p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
            <button
              onClick={() => setFill(null)}
              className="px-3 py-1.5 text-xs text-muted hover:text-white rounded-lg"
            >
              Назад
            </button>
            <button
              onClick={() => emit(fill.tpl, renderTemplate(fill.tpl.content, fill.values))}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-black rounded-lg hover:opacity-90 transition-opacity"
            >
              <Check size={14} /> Вставить
            </button>
          </div>
        </div>
      </div>
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
        <div className="px-4 py-2 border-b border-border shrink-0 flex items-center gap-2">
          <input
            autoFocus
            type="text"
            placeholder="Поиск..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 bg-frame border border-border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
          />
          {categoryNames.length > 0 && (
            <select
              value={catFilter}
              onChange={e => setCatFilter(e.target.value)}
              title="Фильтр по категории"
              className="shrink-0 max-w-[40%] bg-frame border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
            >
              <option value="">Все категории</option>
              {categoryNames.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
        </div>
        <div className="overflow-y-auto flex-1 py-2">
          {visible.length === 0 && (
            <p className="text-xs text-muted px-4 py-3">Шаблоны не найдены</p>
          )}
          {visible.map(t => {
            const catColor = CATEGORY_COLORS[t.category_color ?? ''] ?? 'text-gray-400'
            return (
              <button
                key={t.id}
                onClick={() => handleSelect(t)}
                className="w-full text-left px-4 py-2 hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white flex-1 truncate">{t.name}</span>
                  {t.category_name && (
                    <span className={`text-[9px] uppercase tracking-wide ${catColor} shrink-0`}>{t.category_name}</span>
                  )}
                  {(t.is_dynamic || hasPlaceholders(t.content)) && (
                    <span
                      title="Динамический шаблон — запросит значения"
                      className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wide text-accent bg-accent/10 border border-accent/30 rounded px-1 py-px shrink-0"
                    >
                      <Sparkles size={9} /> дин.
                    </span>
                  )}
                  {t.is_favorite && <Star size={11} className="text-warning fill-warning shrink-0" />}
                  {t.usage_count > 0 && (
                    <span className="text-[10px] text-muted shrink-0">{t.usage_count}</span>
                  )}
                </div>
                <p className="text-[11px] text-muted mt-0.5 line-clamp-2 leading-relaxed">{t.content}</p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Все статусы Okdesk с правилами перехода. Цвета — из src/lib/status.ts,
// label здесь — это действие («Решить»), а не название статуса («Решена»).
const ALL_STATUSES = [
  { code: 'opened',   label: 'Открыть',            bg: STATUS_COLOR.opened,    commentRequired: false, needsDelay: false },
  { code: 'wait',     label: 'В работу',            bg: STATUS_COLOR.wait,      commentRequired: false, needsDelay: false },
  { code: 'delayed',  label: 'Ожидание ответа',     bg: STATUS_COLOR.delayed,   commentRequired: true,  needsDelay: true  },
  { code: 'no_time',  label: 'Отложить',            bg: STATUS_COLOR.no_time,   commentRequired: true,  needsDelay: true  },
  { code: 'completed',label: 'Решить',              bg: STATUS_COLOR.completed, commentRequired: false, needsDelay: false },
  { code: 'closed',   label: 'Закрыть',             bg: STATUS_COLOR.closed,    commentRequired: false, needsDelay: false },
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
                className="w-full bg-frame border border-border rounded-md px-3 py-2 text-xs focus:outline-none focus:border-accent"
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
                className="flex-1 bg-frame border border-border rounded-md px-3 py-2 text-xs resize-none focus:outline-none focus:border-accent leading-relaxed"
              />
              <TemplatePicker onSelect={text => setComment(text)} issueId={issueId} />
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
            style={canSubmit && !mutation.isPending ? statusPillStyle(targetStatus.code) : undefined}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold transition-opacity disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-frame disabled:border disabled:border-border disabled:text-white ${mutation.isPending ? 'animate-pulse cursor-wait' : ''}`}
          >
            {mutation.isPending ? <Working label="Отправляю…" /> : <><Check size={14} /> {targetStatus.label}</>}
          </button>
        </div>

        {mutation.isError && (
          <p className="px-5 pb-4 text-xs text-orange-400">Ошибка при отправке. Попробуйте снова.</p>
        )}
      </div>
    </div>
  )
}

// Расшифровка флагов телеметрии и вывод метрик переехали в TelemetryPanel.

// Управление одиночным анализом: запуск, уточнение номера/даты, предупреждения.
// Данные (таблица разбора, метрики, вердикт) рисуют блоки «① Разбор» и
// «② Телеметрия и вердикт» — они читают тот же кэш `automate-cached`.
function AutoAnalysis({ issueId, issueTitle, companyName }: { issueId: number; issueTitle?: string | null; companyName?: string | null }) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const [result, setResult] = useState<AutomationResult | null>(null)

  // Demo: allow analysis only once per issue. Track in localStorage.
  const demoAnalyzedKey = `demo_analyzed_${issueId}`
  const demoAlreadyAnalyzed = isDemo && !!localStorage.getItem(demoAnalyzedKey)

  // Multi-attachment («общая») issue → single-object analysis is misleading
  // (it picks just the first plate). Defer to «Разбор по объектам» below.
  const { data: attachments = [] } = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })
  const extractCount = attachments.filter(a => a.extractable).length
  // Сохранённый разбор по объектам: если заявка уже помечена агрегатной (ОДКР),
  // одиночный автоанализ ввёл бы в заблуждение — отдаём её «Разбору по объектам».
  const cachedBatchQ = useQuery({
    queryKey: ['batch-cached', issueId],
    queryFn: () => api.getCachedBatch(issueId),
    enabled: extractCount >= 1,
    staleTime: 5 * 60_000,
  })
  const looksAggregate = /одкр/i.test(companyName ?? '') || /общ|одкр/i.test(issueTitle ?? '')
  // Сохранённый разбор по объектам (дешёвый GET; данные есть только если он уже делался).
  const cachedBatch = cachedBatchQ.data?.cached ? cachedBatchQ.data : null
  const cachedBatchObjects = cachedBatch?.objects?.length ?? 0
  // Batch = несколько вложений; ИЛИ одно вложение агрегатной/«общей» заявки;
  // ИЛИ сохранённый разбор пометил заявку как агрегатную;
  // ИЛИ сохранённый разбор вернул >=2 объекта — мультиобъектная заявка даже с 1 вложением
  // (напр. 63317: один файл, ~40 ТС). Тогда одиночный автоанализ вводит в заблуждение.
  const isBatch = extractCount >= 2
    || (extractCount >= 1 && looksAggregate)
    || !!(cachedBatch && cachedBatch.is_aggregate)
    || cachedBatchObjects >= 2

  // Cached result — show last analysis without re-running the AI (saves tokens).
  const cachedQ = useQuery({
    queryKey: ['automate-cached', issueId],
    queryFn: () => api.getCachedAutomate(issueId),
    enabled: !isBatch,
    staleTime: 5 * 60_000,
  })
  const cached = cachedQ.data?.cached ? cachedQ.data : null

  const run = useMutation({
    mutationFn: (override?: { plate?: string; date?: string } | void) => api.automateIssue(issueId, override || undefined),
    onSuccess: (data) => {
      setResult(data)
      if (isDemo) localStorage.setItem(demoAnalyzedKey, '1')
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['automate-cached', issueId] })
      // Трек мог быть закэширован с ошибкой «номер не найден» до анализа — сбрасываем (64736, 64965)
      queryClient.invalidateQueries({ queryKey: ['track', issueId] })
    },
  })

  const shown = result ?? (cached as AutomationResult | null)
  const p = shown?.parsed
  const isCached = !result && !!cached

  // Подозрение на ошибку клиента в гос.номере: не тот формат ИЛИ объект не найден в мониторинге.
  const plateSuspect = !!shown && (!!p?.plate_format_suspect || shown.error === 'object_not_found')

  // У мультиобъектной заявки разбор ведёт BatchAnalysis в том же блоке —
  // одиночный автоанализ взял бы только первый ТС и вводил бы в заблуждение.
  if (isBatch) return null

  // Анализ уже есть → кнопка сжимается в иконку «обновить» и уходит вправо;
  // первичный запуск остаётся широкой текстовой кнопкой (главное действие блока).
  const compact = !!shown

  return (
    <div className="space-y-3">
      <div className={compact ? 'flex justify-end' : ''}>
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending || demoAlreadyAnalyzed}
          title={demoAlreadyAnalyzed ? 'Демо: анализ доступен один раз' : compact ? 'Обновить анализ' : undefined}
          className={`flex items-center justify-center gap-2 bg-card border border-accent/40 text-accent hover:bg-accent/10 text-xs font-semibold rounded-md transition-colors disabled:opacity-40 ${compact ? (run.isPending ? 'px-2.5 py-1.5' : 'p-1.5') : 'w-full py-2'} ${run.isPending ? 'animate-pulse cursor-wait' : ''} ${demoAlreadyAnalyzed ? 'cursor-not-allowed' : ''}`}
        >
          {run.isPending ? (
            <Working label={compact ? 'Анализирую…' : 'Анализирую заявку и данные geo…'} />
          ) : compact ? (
            <RefreshCw size={15} />
          ) : (
            <><Bot size={14} /> Автоанализ заявки</>
          )}
        </button>
      </div>

      {isCached && (
        <p className="flex items-center gap-1 text-[10px] text-muted/70"><Database size={11} /> показан сохранённый анализ{cachedQ.data?.created_at ? ` от ${new Date(cachedQ.data.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      )}

      {run.isError && (
        <p className="text-xs text-orange-400">Ошибка анализа. Попробуйте снова.</p>
      )}

      {/* Пока идёт ПЕРВЫЙ анализ (результата ещё нет) — заметная заглушка в области данных */}
      {run.isPending && !shown && (
        <div className="flex items-center gap-2 bg-frame border border-accent/30 rounded-md px-3 py-3 text-xs text-secondary animate-pulse">
          <Loader2 size={15} className="animate-spin text-accent shrink-0" />
          <span>ИИ анализирует заявку и данные… это может занять несколько секунд.</span>
        </div>
      )}

      {shown && (
        <div className="space-y-2.5 text-xs">
          {shown.error && (
            <p className="flex items-start gap-1.5 text-warning"><AlertTriangle size={13} className="shrink-0 mt-0.5" /> {shown.reasoning}</p>
          )}

          {/* «Что прочитал ИИ» переехало в блок «① Разбор» — гос.номер, дата и
              пробеги живут в таблице разбора, там же и правятся. */}

          {/* Заметное предупреждение о вероятной ошибке клиента в гос.номере. */}
          {plateSuspect && (
            <div className="flex items-start gap-2 bg-warning/10 border border-warning/40 rounded-md px-3 py-2.5 text-warning">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span className="text-[11px] leading-relaxed">
                {p?.plate_format_suspect
                  ? <>Гос.номер «<b className="font-semibold">{p?.plate ?? '—'}</b>» не соответствует формату — вероятно, ошибка клиента. Исправьте номер прямо в таблице разбора.</>
                  : <>Гос.номер «<b className="font-semibold">{p?.plate ?? '—'}</b>» не найден в системе мониторинга — возможно, ошибка клиента в номере. Исправьте номер прямо в таблице разбора.</>}
              </span>
            </div>
          )}

          {/* Сетка метрик и строка вердикта переехали в TelemetryPanel — блок
              «② Телеметрия и вердикт» рисует их по выбранному в таблице объекту. */}

          {shown.draft_answer && (
            <div className="space-y-1.5">
              {shown.needs_remote_diagnostics && (
                <div className="flex items-start gap-1.5 bg-warning/10 border border-warning/30 rounded-md px-3 py-2 text-[11px] text-warning leading-relaxed">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" /> Требуется удалённая диагностика (клиент подтвердил питание)
                </div>
              )}
              {shown.spec_vehicle && (
                <div className="flex items-start gap-1.5 bg-warning/10 border border-warning/30 rounded-md px-3 py-2 text-[11px] text-warning leading-relaxed">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" /> Спецтехника — оценивать по факту работы
                </div>
              )}
              {/* Обоснование вердикта переехало в блок «② Телеметрия и вердикт» —
                  оно объясняет метрики, а не разбор. */}
            </div>
          )}
        </div>
      )}
      {/* Черновик ответа показывает блок «Ответ» (кнопка «Составить ответ»),
          решение заявки — липкий бар. Здесь ни того, ни другого нет: одно
          действие на экране и один источник черновика. */}
    </div>
  )
}

/**
 * Разбор одиночной заявки — та же таблица, что и у пакетной, но из одной строки.
 * Оператор видит разбор одинаково независимо от того, один в заявке объект или
 * двадцать. Данные берём из кэша автоанализа: он уже содержит и распознанные
 * поля, и телеметрию.
 */
function SingleParseTable({ issueId, onSelect }: { issueId: number; onSelect?: (obj: import('../types').BatchObject) => void }) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  // Какое поле сейчас правится / сохраняется. Правка только по клику на карандаш —
  // защита от случайного изменения. cancelEditRef — отмена по Escape (blur без применения).
  const [editingField, setEditingField] = useState<'plate' | 'date' | null>(null)
  const [savingField, setSavingField] = useState<'plate' | 'date' | null>(null)
  const cancelEditRef = useRef(false)

  const { data } = useQuery({
    queryKey: ['automate-cached', issueId],
    queryFn: () => api.getCachedAutomate(issueId),
    staleTime: 5 * 60_000,
  })
  const res = data?.cached ? (data as unknown as AutomationResult) : null
  const p = res?.parsed
  const t = res?.telemetry

  // Уточнение номера/даты = переанализ заявки по исправленным данным.
  const refine = useMutation({
    mutationFn: (override: { plate?: string; date?: string }) => api.automateIssue(issueId, override),
    onSettled: () => setSavingField(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automate-cached', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      // Трек мог быть закэширован с ошибкой «номер не найден» до правки — сбрасываем.
      queryClient.invalidateQueries({ queryKey: ['track', issueId] })
    },
  })

  const applyEdit = (field: 'plate' | 'date', raw: string) => {
    const val = raw.trim()
    const current = (field === 'plate' ? p?.plate : p?.date) ?? ''
    if (!val || val === current) return
    setSavingField(field)
    refine.mutate({ [field]: val })
  }

  // Строку отдаём наверх, чтобы блок телеметрии показывал этот же объект.
  useEffect(() => {
    if (!res || !onSelect) return
    onSelect({
      file: '', plate: p?.plate ?? null, date: p?.date ?? null,
      sheet_mileage_km: p?.sheet_mileage_km ?? null,
      declared_system_km: p?.declared_system_km ?? null,
      system_mileage_km: t?.system_mileage_km ?? null,
      flags: t?.flags ?? [], teleport_jumps: t?.teleport_jumps ?? 0,
      verdict: res.category, telemetry: t ?? null,
      spec_vehicle: res.spec_vehicle,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res])

  if (!res) return null

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead className="text-muted">
          <tr className="text-left">
            <th className="font-medium pb-1.5 pr-2">Гос.номер</th>
            <th className="font-medium pb-1.5 pr-2">Дата</th>
            <th className="font-medium pb-1.5 pr-2">ПЛ</th>
            <th className="font-medium pb-1.5 pr-2">ГЛОНАСС заявл.</th>
            <th className="font-medium pb-1.5 pr-2">По факту</th>
            <th className="font-medium pb-1.5 pr-2">Вердикт</th>
            <th className="font-medium pb-1.5 text-center">Трек</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-border/50">
            <td className="py-1.5 pr-2 font-mono">
              {isDemo ? (p?.plate ?? '—') : editingField === 'plate' ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    autoFocus
                    defaultValue={p?.plate ?? ''}
                    disabled={savingField === 'plate'}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      else if (e.key === 'Escape') { cancelEditRef.current = true; (e.target as HTMLInputElement).blur() }
                    }}
                    onBlur={e => {
                      const val = e.target.value
                      setEditingField(null)
                      if (cancelEditRef.current) { cancelEditRef.current = false; return }
                      applyEdit('plate', val)
                    }}
                    className="w-[5.5rem] bg-frame border border-accent rounded px-1 py-0.5 font-mono text-[11px] text-white outline-none disabled:opacity-50"
                  />
                  <span className="text-[9px] text-muted/60 shrink-0">Enter / Esc</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <span className={p?.plate ? '' : 'text-warning'}>{p?.plate ?? 'нет номера'}</span>
                  <button
                    onClick={() => setEditingField('plate')}
                    title={p?.plate ? 'Изменить гос.номер и перепроверить ТС в гео' : 'Вписать гос.номер вручную и проверить в гео'}
                    className="text-muted/40 hover:text-accent shrink-0 transition-colors"
                  ><Pencil size={11} /></button>
                  {savingField === 'plate' && <span className="animate-spin text-muted shrink-0">↻</span>}
                </span>
              )}
            </td>
            <td className="pr-2">
              {isDemo ? (p?.date ?? '—') : editingField === 'date' ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    type="date"
                    autoFocus
                    defaultValue={p?.date ?? ''}
                    disabled={savingField === 'date'}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      else if (e.key === 'Escape') { cancelEditRef.current = true; (e.target as HTMLInputElement).blur() }
                    }}
                    onBlur={e => {
                      const val = e.target.value
                      setEditingField(null)
                      if (cancelEditRef.current) { cancelEditRef.current = false; return }
                      applyEdit('date', val)
                    }}
                    className="w-[8.5rem] bg-frame border border-accent rounded px-1 py-0.5 text-[11px] text-white outline-none disabled:opacity-50"
                  />
                  <span className="text-[9px] text-muted/60 shrink-0">Enter / Esc</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <span className={p?.date ? '' : 'text-warning'}>{p?.date ?? 'нет даты'}</span>
                  <button
                    onClick={() => setEditingField('date')}
                    title="Изменить дату неисправности и перепроверить в гео"
                    className="text-muted/40 hover:text-accent shrink-0 transition-colors"
                  ><Pencil size={11} /></button>
                  {savingField === 'date' && <span className="animate-spin text-muted shrink-0">↻</span>}
                </span>
              )}
            </td>
            <td className="pr-2">{p?.sheet_mileage_km ?? '—'}</td>
            <td className="pr-2">{p?.declared_system_km ?? '—'}</td>
            <td className="pr-2 text-white font-medium">{t?.system_mileage_km ?? '—'}</td>
            <td className="pr-2">
              <span className={VERDICT_STYLE[res.category] ?? 'text-white'}>{res.category}</span>
              {res.spec_vehicle && (
                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-pill bg-warning/15 text-warning text-[9px] font-medium align-middle">
                  спецтехника
                </span>
              )}
            </td>
            <td className="text-center">
              <TrackLink plate={p?.plate ?? null} date={p?.date ?? null} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function TrackLink({ plate, date }: { plate: string | null; date: string | null }) {
  const openTrack = useIssuesStore(s => s.openTrack)
  if (!plate || !date) return null
  return (
    <button
      onClick={() => openTrack(plate, date)}
      title="Карта и графики этого ТС"
      className="inline-flex text-muted hover:text-accent transition-colors"
    ><Map size={14} /></button>
  )
}

const VERDICT_STYLE: Record<string, string> = {
  'Глушение': 'text-warning',
  'Данные верны': 'text-green-400',
  'Не было питания': 'text-orange-400',
  'Объект не найден': 'text-red-400',
  'Нет данных': 'text-muted',
  'Нет номера/даты': 'text-muted',
  'Номер не распознан': 'text-warning',
  'Проверить': 'text-cyan-400',
}


function ComposeAnswerButton({ issueId, hasExtractable, onUseDraft }: { issueId: number; hasExtractable: boolean; onUseDraft: (text: string) => void }) {
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const composeMut = useMutation({
    mutationFn: async () => {
      // Есть извлекаемые вложения → ответ по таблице разбора.
      // Нет вложений → ответ на основе одиночного автоанализа заявки.
      if (hasExtractable) {
        const data = await api.composeAnswer(issueId)
        return data.answer
      }
      const data = await api.automateIssue(issueId)
      return data.draft_answer
    },
    onSuccess: (answer) => { if (answer) onUseDraft(answer) },
  })
  return (
    <>
      <button
        onClick={() => composeMut.mutate()}
        disabled={composeMut.isPending || isDemo}
        title={isDemo ? 'Недоступно в демо-режиме' : undefined}
        className={`flex items-center justify-center gap-1.5 w-full bg-accent/90 hover:bg-accent text-black text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-40 ${composeMut.isPending ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
      >
        {composeMut.isPending
          ? <Working label="Составляю ответ…" />
          : <><Sparkles size={14} /> Составить ответ</>}
      </button>
      {composeMut.isError && <p className="text-xs text-orange-400">Ошибка составления ответа. Попробуйте снова.</p>}
    </>
  )
}

function BatchAnalysis({ issueId, issueTitle, issueDescription, onOpenExternal, selectedIdx, onSelectObject }: {
  issueId: number
  issueTitle?: string | null
  issueDescription?: string | null
  companyName?: string | null
  onOpenExternal: (extId: number) => void
  /** Индекс строки, чью телеметрию показывает блок «② Телеметрия и вердикт». */
  selectedIdx?: number | null
  onSelectObject?: (idx: number, objects: import('../types').BatchObject[]) => void
}) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const openTrack = useIssuesStore(s => s.openTrack)
  const trackOpen = useIssuesStore(s => s.trackOpen)
  const trackPlate = useIssuesStore(s => s.trackPlate)
  const trackDate = useIssuesStore(s => s.trackDate)
  const batchChildren = useIssuesStore(s => s.batchChildren)
  const setBatchChild = useIssuesStore(s => s.setBatchChild)
  const clearBatchChildren = useIssuesStore(s => s.clearBatchChildren)
  const [loadingPlates, setLoadingPlates] = useState<Set<string>>(new Set())
  const [verdictLoading, setVerdictLoading] = useState<Set<string>>(new Set())
  const [verdictError, setVerdictError] = useState<string | null>(null)
  const [plateLoading, setPlateLoading] = useState<Set<string>>(new Set())
  const [plateError, setPlateError] = useState<string | null>(null)
  // Какая строка сейчас в режиме правки номера (защита от случайной правки —
  // правим только по явному клику на карандаш). cancelPlateRef — отмена по Escape.
  const [editingPlateKey, setEditingPlateKey] = useState<string | null>(null)
  const cancelPlateRef = useRef(false)
  const [localBatch, setLocalBatch] = useState<import('../types').BatchResult | null>(null)
  // Авто-дораспознавание больших сканов: счётчик проходов и последний прогресс
  // (чтобы остановиться при отсутствии продвижения, а не крутить бесконечно).
  const ocrRoundsRef = useRef(0)
  const lastPagesRef = useRef(-1)
  const ocrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // autoOcr — цикл реально активен (запланирован следующий проход). Завязывать
  // занятость на счётчик проходов нельзя: при остановке по «нет прогресса» он
  // застрял бы в (0, MAX) и кнопка осталась бы заблокированной навсегда.
  const [autoOcr, setAutoOcr] = useState(false)
  const MAX_OCR_ROUNDS = 15

  // Отменить запланированный проход (смена заявки / размонтирование / стоп).
  const cancelOcrLoop = () => {
    if (ocrTimerRef.current != null) { clearTimeout(ocrTimerRef.current); ocrTimerRef.current = null }
  }

  useEffect(() => {
    setLocalBatch(null)
    setVerdictError(null)
    setPlateError(null)
    // Сброс авто-дораспознавания: ключи завязаны на конкретную заявку — нельзя,
    // чтобы запланированный проход выстрелил по другой/закрытой заявке.
    ocrRoundsRef.current = 0
    lastPagesRef.current = -1
    setAutoOcr(false)
    return cancelOcrLoop
  }, [issueId])

  // Per-issue child creation map — survives panel close/reopen (global store, not local state)
  const rowCreated = batchChildren[issueId] ?? {}
  // Ключ строки = индекс|номер|дата|файл: статус «создано»/спиннер/правка строго по
  // своей строке. Индекс нужен для строк БЕЗ номера (несколько нераспознанных актов
  // с одной датой в одном файле иначе имели бы одинаковый ключ).
  const rowKey = (o: import('../types').BatchObject, idx: number) => `${idx}|${o.plate ?? ''}|${o.date ?? ''}|${o.file ?? ''}`

  const { data: attachments = [] } = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })
  const extractable = attachments.filter(a => a.extractable)
  // Заявка без вложений, но с >=2 гос.номерами в ТЕМЕ ИЛИ ТЕЛЕ письма — разбираем
  // по тексту (бэк умеет automate_batch по теме+телу). Тело нужно для 65649: тема =
  // дата, список ТС — в теле письма.
  const multiInText = countPlates(`${issueTitle ?? ''}\n${stripHtml(issueDescription)}`) >= 2
  // Подтягиваем сохранённый разбор при наличии хотя бы одного извлекаемого вложения
  // (дешёвый GET — вернёт данные только если разбор уже делали). Нужно, чтобы
  // распознать агрегатность по кешу даже без подсказки в теме/компании.
  const cachedQ = useQuery({
    queryKey: ['batch-cached', issueId],
    queryFn: () => api.getCachedBatch(issueId),
    enabled: extractable.length >= 1 || multiInText,
    staleTime: 5 * 60_000,
  })
  const cached = cachedQ.data?.cached ? cachedQ.data : null

  const run = useMutation({
    mutationFn: () => api.automateBatch(issueId),
    onSuccess: (data) => {
      setLocalBatch(null)
      setVerdictError(null)
      queryClient.invalidateQueries({ queryKey: ['batch-cached', issueId] })
      // Авто-дораспознавание: сервер за один проход осиливает не весь большой PDF.
      // Пока complete=false и есть ПРОДВИЖЕНИЕ по страницам — повторяем разбор сами,
      // оператору не нужно гадать, сколько раз жать. Если прогресс встал (страницы
      // не растут) или достигнут лимит проходов — останавливаемся и снимаем autoOcr,
      // чтобы кнопка «Продолжить распознавание» снова стала доступна (не залипала).
      const prog = data?.ocr_progress
      const pages = prog?.pages_done ?? 0
      if (prog && prog.complete === false
          && ocrRoundsRef.current < MAX_OCR_ROUNDS
          && pages > lastPagesRef.current) {
        lastPagesRef.current = pages
        ocrRoundsRef.current += 1
        setAutoOcr(true)
        ocrTimerRef.current = setTimeout(() => run.mutate(), 400)
      } else {
        setAutoOcr(false)
      }
    },
    onError: () => setAutoOcr(false),
  })

  // Старт разбора по кнопке: сбрасываем счётчики авто-дораспознавания и статус
  // дочерних (повторный разбор не должен наследовать старые отметки).
  const startRun = () => {
    cancelOcrLoop()
    ocrRoundsRef.current = 0
    lastPagesRef.current = -1
    setAutoOcr(true)
    setLocalBatch(null)
    clearBatchChildren(issueId)
    run.mutate()
  }

  const createRow = async (o: import('../types').BatchObject, idx: number) => {
    if (!o.plate) return
    const key = rowKey(o, idx)
    setLoadingPlates(prev => new Set([...prev, key]))
    try {
      // Передаём РОВНО эту строку (объект + её дата) — дочерняя создаётся только по
      // выбранной дате неисправности, а не по всем строкам этого номера.
      const res = await api.createChildren(issueId, [o])
      const r = res.results[0]
      setBatchChild(issueId, key, { issue_id: r?.issue_id, ok: r?.ok ?? false })
      // Backend caches child immediately — just invalidate queries
      queryClient.invalidateQueries({ queryKey: ['issues'] })
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
    } catch {
      setBatchChild(issueId, key, { ok: false })
    } finally {
      setLoadingPlates(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Ручная правка гос.номера: бэкенд заново ищет ТС в гео по верному номеру и
  // обновляет вердикт/трек/пробег этой строки (кейс «OCR исказил номер», 64722;
  // и строки без номера, 64725). idx — точный селектор строки на бэкенде.
  const handlePlateChange = async (o: import('../types').BatchObject, raw: string, idx: number) => {
    const np = raw.trim().toUpperCase()
    // Разрешаем и для строк БЕЗ номера (акт распознан, но OCR не прочитал гос.номер —
    // оператор вписывает вручную, 64725). Нужно лишь непустое новое значение.
    if (!np || np === (o.plate ?? '').toUpperCase()) return
    const key = rowKey(o, idx)
    setPlateLoading(prev => new Set([...prev, key]))
    setPlateError(null)
    try {
      const updated = await api.updateBatchPlate(issueId, o.plate ?? '', np, o.date || undefined, o.file || undefined, idx)
      setLocalBatch(updated)
    } catch {
      setPlateError(`Не удалось обновить номер на ${np} — проверьте, найден ли он в гео.`)
    } finally {
      setPlateLoading(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Кнопка «Разбор по объектам» доступна для любой заявки с >=1 извлекаемым вложением —
  // оператор может вручную запустить разбор (напр. 63317: 1 файл, ~40 ТС). Авто-запуск
  // OCR не делаем; таблица рисуется из результата run/кеша (>=2 объекта → мультиобъект).
  if (extractable.length < 1 && !multiInText) return null

  const res = localBatch ?? run.data ?? (cached as BatchResult | null)
  const isCached = !localBatch && !run.data && !!cached
  const isAggregate = !!res?.is_aggregate
  // OCR ещё не дочитал все вложения → идёт авто-дораспознавание (или предложить
  // продолжить, если цикл остановился по лимиту проходов).
  const ocrProg = res?.ocr_progress
  const ocrPending = !!ocrProg && ocrProg.complete === false
  // Заняты, только пока реально идёт проход или запланирован следующий (autoOcr).
  // При остановке цикла (стоп прогресса/лимит) autoOcr=false → кнопка «Продолжить».
  const ocrBusy = run.isPending || autoOcr

  const ALLOWED_VERDICTS = ['Глушение', 'Данные верны', 'Не было питания', 'Нет данных', 'Терминал подключился', 'Проверить'] as const

  const handleVerdictChange = async (o: import('../types').BatchObject, newVerdict: string, idx: number) => {
    if (!o.plate) return
    // Ключ строки (idx|номер|дата|файл) — правка и спиннер строго по этой строке.
    const key = rowKey(o, idx)
    setVerdictLoading(prev => new Set([...prev, key]))
    setVerdictError(null)
    try {
      const updated = await api.updateBatchVerdict(issueId, o.plate, newVerdict, o.file || undefined, o.date || undefined)
      setLocalBatch(updated)
    } catch {
      setVerdictError(`Не удалось сохранить вердикт для ${o.plate}`)
    } finally {
      setVerdictLoading(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Разбор уже есть → иконочная кнопка «обновить» справа. Первичный запуск и
  // «продолжить распознавание» остаются текстовыми: без подписи их смысл теряется.
  const compact = !!res && !ocrPending

  return (
    <div className="space-y-2">
      <div className={compact ? 'flex justify-end' : ''}>
        <button
          onClick={startRun}
          disabled={ocrBusy || isDemo}
          title={isDemo ? 'Недоступно в демо-режиме' : compact ? 'Обновить разбор' : undefined}
          className={`flex items-center justify-center gap-2 bg-card border border-info/40 text-info hover:bg-info/10 text-xs font-semibold rounded-md transition-colors disabled:opacity-40 ${compact ? (ocrBusy ? 'px-2.5 py-1.5' : 'p-1.5') : 'w-full py-2'} ${ocrBusy ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
        >
          {ocrBusy ? (
            <Working label={compact ? 'Распознаю…' : 'Распознаю вложения…'} />
          ) : ocrPending ? (
            <><RefreshCw size={14} /> Продолжить распознавание</>
          ) : res ? (
            <RefreshCw size={15} />
          ) : (
            <><Layers size={14} /> Разбор заявки</>
          )}
        </button>
      </div>
      {ocrProg && ocrProg.complete === false && (
        <div className="flex items-center gap-2 bg-frame border border-info/30 rounded-md px-3 py-2 text-[11px] text-secondary">
          <Loader2 size={13} className={`text-info shrink-0 ${ocrBusy ? 'animate-spin' : ''}`} />
          <span>
            Распознавание больших сканов: вложений {ocrProg.attachments_done}/{ocrProg.attachments_total}, страниц {ocrProg.pages_done}.
            {ocrBusy ? ' Идёт авто-дораспознавание…' : ' Нажмите «Продолжить распознавание», чтобы дочитать остаток.'}
          </span>
        </div>
      )}
      {isCached && (
        <p className="flex items-center gap-1 text-[10px] text-muted/70"><Database size={11} /> показан сохранённый разбор{cachedQ.data?.created_at ? ` от ${new Date(cachedQ.data.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      )}

      {/* Первый разбор (результата ещё нет) — заметная заглушка */}
      {run.isPending && !res && (
        <div className="flex items-center gap-2 bg-frame border border-info/30 rounded-md px-3 py-3 text-xs text-secondary animate-pulse">
          <Loader2 size={15} className="animate-spin text-info shrink-0" />
          <span>ИИ разбирает объекты заявки… это может занять несколько секунд.</span>
        </div>
      )}

      {res && (
        <div className="space-y-2 text-xs">
          <div className="text-[11px] text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>Всего {res.total}:</span>
            {(() => {
              const counts: Record<string, number> = {}
              for (const o of res.objects) counts[o.verdict] = (counts[o.verdict] ?? 0) + 1
              const order = ['Глушение', 'Данные верны', 'Не было питания', 'Терминал подключился', 'Изменили настройки', 'Проверить', 'Нет данных', 'Объект не найден', 'Номер не распознан', 'Нет номера/даты', 'Ошибка данных']
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
                  <th className="pr-2">ПЛ</th><th className="pr-2">ГЛОНАСС заявл.</th><th className="pr-2">По факту</th><th className="pr-2">Вердикт</th><th className="pr-1"></th><th></th>
                </tr>
              </thead>
              <tbody>
                {res.objects.map((o, idx) => {
                  const key = rowKey(o, idx)
                  const rc = o.plate ? rowCreated[key] : null
                  const isLoading = !!o.plate && loadingPlates.has(key)
                  const isVerdictLoading = !!o.plate && verdictLoading.has(key)
                  const isPlateLoading = plateLoading.has(key)
                  return (
                    <tr
                      key={idx}
                      onClick={() => onSelectObject?.(idx, res.objects)}
                      title="Показать телеметрию этого ТС"
                      className={`border-t border-border/50 cursor-pointer ${
                        trackOpen && trackPlate === o.plate && trackDate === o.date
                          ? 'bg-accent/10 border-l-2 border-l-accent/60'
                          : selectedIdx === idx
                          ? 'bg-card-hover border-l-2 border-l-accent'
                          : 'hover:bg-card-hover/60'
                      }`}
                    >
                      <td className="py-1 pr-2 font-mono">
                        {isDemo ? (o.plate ?? '—') : editingPlateKey === key ? (
                          <span className="inline-flex items-center gap-1">
                            <input
                              autoFocus
                              defaultValue={o.plate ?? ''}
                              disabled={isPlateLoading}
                              onKeyDown={e => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                else if (e.key === 'Escape') { cancelPlateRef.current = true; (e.target as HTMLInputElement).blur() }
                              }}
                              onBlur={e => {
                                const val = e.target.value
                                setEditingPlateKey(null)
                                if (cancelPlateRef.current) { cancelPlateRef.current = false; return }
                                handlePlateChange(o, val, idx)
                              }}
                              className="w-[5.5rem] bg-frame border border-accent rounded px-1 py-0.5 font-mono text-[11px] text-white outline-none disabled:opacity-50"
                            />
                            <span className="text-[9px] text-muted/60 shrink-0">Enter / Esc</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <span className={o.plate ? '' : 'text-warning'}>{o.plate ?? 'нет номера'}</span>
                            <button
                              onClick={() => setEditingPlateKey(key)}
                              title={o.plate ? 'Изменить гос.номер и перепроверить ТС в гео' : 'Вписать гос.номер вручную (OCR не распознал) и проверить в гео'}
                              className="text-muted/40 hover:text-accent shrink-0 transition-colors"
                            ><Pencil size={11} /></button>
                            {o.plate_edited && <span title="Номер изменён оператором, перепроверено в гео" className="text-info shrink-0">●</span>}
                            {isPlateLoading && <span className="animate-spin text-muted shrink-0">↻</span>}
                          </span>
                        )}
                      </td>
                      <td className="pr-2">{o.date ?? '—'}</td>
                      <td className="pr-2">{o.sheet_mileage_km ?? '—'}</td>
                      <td className="pr-2">{o.declared_system_km ?? '—'}</td>
                      <td className="pr-2">{o.system_mileage_km ?? '—'}</td>
                      <td className="pr-2">
                        {isDemo ? (
                          <span className={VERDICT_STYLE[o.verdict] ?? 'text-white'}>{o.verdict}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <select
                              value={o.verdict}
                              disabled={isVerdictLoading}
                              onChange={e => handleVerdictChange(o, e.target.value, idx)}
                              title={o.verdict_edited ? 'Изменено оператором' : undefined}
                              className={`bg-transparent border-0 outline-none cursor-pointer text-[11px] font-medium appearance-none pr-1 disabled:opacity-50 disabled:cursor-wait ${VERDICT_STYLE[o.verdict] ?? 'text-white'}`}
                            >
                              {ALLOWED_VERDICTS.map(v => (
                                <option key={v} value={v} className="bg-card text-primary">{v}</option>
                              ))}
                              {!ALLOWED_VERDICTS.includes(o.verdict as typeof ALLOWED_VERDICTS[number]) && (
                                <option value={o.verdict} className="bg-card text-primary">{o.verdict}</option>
                              )}
                            </select>
                            {o.verdict_edited && (
                              <span title="Изменено оператором" className="text-info shrink-0">●</span>
                            )}
                            {isVerdictLoading && (
                              <span className="animate-spin text-muted shrink-0">↻</span>
                            )}
                          </span>
                        )}
                        {o.spec_vehicle && (
                          <span
                            title="Спецтехника без км-пробега — оценивать по факту работы/моточасам"
                            className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-pill bg-warning/15 text-warning text-[9px] font-medium align-middle"
                          >
                            спецтехника
                          </span>
                        )}
                      </td>
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
                              onClick={() => !isDemo && createRow(o, idx)}
                              title={isDemo ? 'Недоступно в демо-режиме' : 'Создать дочернюю заявку'}
                              disabled={isDemo}
                              className={`inline-flex transition-colors ${isDemo ? 'text-muted/40 cursor-not-allowed' : 'text-muted hover:text-accent'}`}
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
          {isAggregate && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted leading-relaxed">
              <Info size={13} className="shrink-0 mt-0.5 text-info" />
              <span>Агрегатная заявка (ОДКР) — отвечаем одним ответом по всем объектам, без разбивки на дочерние.</span>
            </p>
          )}
          {!isAggregate && (() => {
            const children = res.objects.filter((o, i) => o.plate && !rowCreated[rowKey(o, i)]?.ok && (o.verdict === 'Данные верны' || o.verdict === 'Нет данных'))
            const totalEligible = res.objects.filter(o => o.verdict === 'Данные верны' || o.verdict === 'Нет данных').length
            if (totalEligible === 0) return null
            return (
              <>
                <p className="flex items-start gap-1.5 text-[11px] text-muted leading-relaxed">
                  <Lightbulb size={13} className="shrink-0 mt-0.5" />
                  <span>Отдельные заявки: «данные верны» {res.objects.filter(o => o.verdict === 'Данные верны').length}{res.objects.filter(o => o.verdict === 'Нет данных').length ? `, «нет данных» ${res.objects.filter(o => o.verdict === 'Нет данных').length}` : ''} — создавайте по одной кнопкой в строке таблицы.</span>
                </p>
                {children.length === 0 && <p className="flex items-center gap-1.5 text-xs text-green-400"><Check size={14} /> Все дочерние заявки созданы</p>}
              </>
            )
          })()}
        </div>
      )}
      {run.isError && <p className="text-xs text-orange-400">Ошибка разбора. Попробуйте снова.</p>}
      {verdictError && <p className="text-xs text-orange-400">{verdictError}</p>}
      {plateError && <p className="text-xs text-orange-400">{plateError}</p>}
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

  // Свёрнуто по умолчанию: вложения в рельсе нужны точечно, а список из
  // нескольких файлов оттесняет вниз более важный контекст заявки.
  const [open, setOpen] = useState(false)

  if (items.length === 0) return null

  return (
    <Block
      icon={Paperclip}
      title="Вложения"
      count={items.length}
      right={
        <button
          onClick={() => setOpen(v => !v)}
          title={open ? 'Свернуть список вложений' : 'Показать вложения'}
          className="flex items-center text-muted hover:text-white transition-colors"
        >
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      }
    >
      {open && (
      <div className="space-y-1.5">
        {items.map(a => {
          const KI = KIND_ICON[a.kind] ?? Paperclip
          const url = api.attachmentUrl(issueId, a.id)
          return (
            <a
              key={a.id}
              href={url}
              target="_blank"
              rel="noreferrer"
              title="Открыть / скачать вложение"
              className="flex items-center gap-2.5 bg-frame border border-border hover:border-accent rounded-md px-3 py-2 group transition-colors"
            >
              <KI size={18} className="shrink-0 text-muted" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-white truncate">{a.name ?? `#${a.id}`}</div>
                <div className="text-[10px] text-muted flex items-center gap-1.5">
                  {formatSize(a.size)}
                  {a.extractable && <span className="inline-flex items-center gap-1 text-green-400/80">· <Sparkles size={10} /> ИИ читает</span>}
                  {!a.extractable && a.kind === 'image' && <span className="text-warning/70">· скан (OCR недоступен)</span>}
                </div>
              </div>
              <ExternalLink size={13} className="shrink-0 text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
            </a>
          )
        })}
      </div>
      )}
    </Block>
  )
}

// ExtractedDataBlock удалён: разбор одиночной заявки показывает та же таблица,
// что и пакетный (SingleParseTable), сырые тексты заявки и вложений не нужны —
// письмо клиента есть в блоке «Вопрос клиента».

// Lookbehind как в бэковском `_PLATE_STD_RE`: номер не должен начинаться в середине
// слова/числа (иначе «2.В524ОА» или «Акт122» ложно считаются номером) — чтобы
// countPlates на фронте совпадал с распознаванием номеров на бэке.
const PLATE_RE = /(?<![A-Za-zА-Яа-яЁё0-9.-])[АВЕКМНОРСТУХABEKMHOPCTYX]\s?\d{3}\s?[АВЕКМНОРСТУХABEKMHOPCTYX]{2}\d{0,3}/gi
const LAT_TO_CYR: Record<string, string> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О',
  P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х',
}

function normPlate(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
    .replace(/[ABEKMHOPCTYX]/g, c => LAT_TO_CYR[c] || c)
    // Срезаем хвост региона (2-3 цифры после двух букв) — как `_plate_dedup_key` на
    // бэке: «В418УО162» и «В418УО» = один ТС. Иначе countPlates считал их за 2 и
    // показывал пакетный разбор там, где бэк видит 1 ТС и возвращает пусто.
    .replace(/(?<=[АВЕКМНОРСТУХ]{2})\d{2,3}$/, '')
}
function countPlates(s?: string | null): number {
  if (!s) return 0
  const found = new Set<string>()
  for (const m of s.matchAll(PLATE_RE)) found.add(normPlate(m[0]))
  return found.size
}

/**
 * Единый «мастер» ИИ-анализа карточки заявки.
 * Приводит поток к одному виду для заявок С вложениями и БЕЗ:
 *   1 Разбор → 2 Анализ → 3 Ответ → (решение оператора).
 * Режим определяется автоматически по наличию извлекаемых вложений.
 * Переиспользует существующие компоненты (BatchAnalysis / AutoAnalysis /
 * ExtractedDataBlock / ComposeAnswerButton) без изменения их внутренностей.
 */
/**
 * Пакетный разбор нужен, если есть извлекаемые вложения ИЛИ в теме/теле ≥2
 * гос.номеров. Тело важно для заявок вида 65649: тема = дата, а список из 20 ТС
 * лежит в письме. Вынесено из AnalysisWizard, потому что тот же признак нужен
 * блоку «Ответ» (шаг генерации живёт уже там).
 */
function isBatchIssue(
  issue: { subject?: string | null },
  description: string | null | undefined,
  extractableCount: number,
): boolean {
  if (extractableCount > 0) return true
  return countPlates(`${issue.subject ?? ''}\n${stripHtml(description)}`) >= 2
}

/**
 * Блок «Ответ» (③ в макете v3): генерация черновика ИИ, шаблоны, выбор
 * публичный/приватный и сам композер. Раньше композер лежал внутри
 * «Комментариев», а кнопка генерации — третьим шагом мастера; в v3 это один
 * блок, а смена статуса ушла в липкий бар.
 */
function AnswerBlock({
  issueId,
  useBatch,
  comment,
  setComment,
  commentPublic,
  setCommentPublic,
  onSend,
  sending,
  isDemo,
}: {
  issueId: number
  useBatch: boolean
  comment: string
  setComment: (v: string) => void
  commentPublic: boolean
  setCommentPublic: (v: boolean) => void
  onSend: () => void
  sending: boolean
  isDemo: boolean
}) {
  return (
    <Block title="③ Ответ" right={<span className="text-xs text-muted">черновик ИИ — можно править</span>}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ComposeAnswerButton
            issueId={issueId}
            hasExtractable={useBatch}
            onUseDraft={text => { setComment(text); setCommentPublic(true) }}
          />
          <TemplatePicker onSelect={text => setComment(text)} issueId={issueId} />
        </div>
        {/* Сегмент видимости: публичный ответ уходит клиенту — помечаем янтарём */}
        <div className="flex items-center gap-0.5 bg-frame rounded-md p-0.5 shrink-0">
          {([true, false] as const).map(pub => (
            <button
              key={String(pub)}
              onClick={() => setCommentPublic(pub)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                commentPublic === pub
                  ? pub
                    ? 'bg-warning/15 text-warning'
                    : 'bg-border text-white'
                  : 'text-muted hover:text-white'
              }`}
            >
              {pub ? 'Публичный' : 'Приватный'}
            </button>
          ))}
        </div>
      </div>

      <textarea
        placeholder="Написать ответ или комментарий..."
        value={comment}
        onChange={e => setComment(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment) onSend()
        }}
        rows={5}
        className="w-full bg-frame border border-border rounded-md px-3 py-2.5 text-[13px] leading-5 resize-y focus:outline-none focus:border-accent"
      />

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">
          {commentPublic ? 'Ответ уйдёт клиенту публичным комментарием' : 'Приватный — виден только сотрудникам'}
          {' · Ctrl+Enter — отправить'}
        </p>
        <button
          disabled={!comment || sending || isDemo}
          onClick={onSend}
          title={isDemo ? 'Недоступно в демо-режиме' : 'Отправить комментарий (Ctrl+Enter)'}
          className={`flex items-center gap-1.5 bg-frame border border-border hover:border-accent rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-40 text-secondary hover:text-accent shrink-0 ${isDemo ? 'cursor-not-allowed' : ''}`}
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Отправить
        </button>
      </div>
    </Block>
  )
}

const AI_ERROR_KINDS: { value: import('../types').AiFeedbackErrorKind; label: string }[] = [
  { value: 'wrong_verdict', label: 'Неверный вердикт' },
  { value: 'wrong_plate', label: 'Неверный гос.номер' },
  { value: 'wrong_date', label: 'Неверная дата' },
  { value: 'wrong_mileage', label: 'Неверный пробег' },
  { value: 'other', label: 'Другое' },
]

const AI_ERROR_KIND_LABEL: Record<string, string> = Object.fromEntries(
  AI_ERROR_KINDS.map(k => [k.value, k.label]),
)

/**
 * Оценка качества ИИ-разбора заявки (петля обратной связи).
 * Показывает текущую оценку (если есть) и форму для её выставления/изменения.
 */
function AiFeedbackPanel({ issueId }: { issueId: number }) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const [showBadForm, setShowBadForm] = useState(false)
  const [errorKind, setErrorKind] = useState<import('../types').AiFeedbackErrorKind>('wrong_verdict')
  const [fbComment, setFbComment] = useState('')
  const [correctCategory, setCorrectCategory] = useState('')

  useEffect(() => {
    setShowBadForm(false)
    setErrorKind('wrong_verdict')
    setFbComment('')
    setCorrectCategory('')
  }, [issueId])

  const { data: fbData } = useQuery({
    queryKey: ['ai-feedback', issueId],
    queryFn: () => api.getAiFeedback(issueId),
    enabled: issueId != null,
    staleTime: 30_000,
  })
  const feedback = fbData?.feedback ?? null

  const submit = useMutation({
    mutationFn: (body: import('../types').AiFeedbackBody) => api.addAiFeedback(issueId, body),
    onSuccess: () => {
      setShowBadForm(false)
      queryClient.invalidateQueries({ queryKey: ['ai-feedback', issueId] })
    },
  })

  const saveGood = () => submit.mutate({ rating: 'good' })
  const saveBad = () =>
    submit.mutate({
      rating: 'bad',
      error_kind: errorKind,
      ...(fbComment.trim() ? { comment: fbComment.trim() } : {}),
      ...(correctCategory.trim() ? { correct_category: correctCategory.trim() } : {}),
    })

  // Заголовок даёт внешний Block (в v3 это самостоятельный блок правого рельса).
  return (
    <div className="space-y-2">
      {/* Текущая оценка */}
      {feedback && (
        <div className="bg-frame rounded-md px-3 py-2 space-y-1 text-[11px]">
          <div className="flex items-center gap-2">
            {feedback.rating === 'good' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-green-500/15 text-green-400 font-medium">
                <Check size={11} /> верно
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-orange-500/15 text-orange-400 font-medium">
                <X size={11} /> с ошибкой
              </span>
            )}
            {feedback.rating === 'bad' && feedback.error_kind && (
              <span className="text-warning">{AI_ERROR_KIND_LABEL[feedback.error_kind] ?? feedback.error_kind}</span>
            )}
          </div>
          {feedback.comment && (
            <p className="text-white/80 leading-relaxed whitespace-pre-wrap">{feedback.comment}</p>
          )}
          {feedback.correct_category && (
            <p className="text-muted">Правильная категория: <span className="text-white/80">{feedback.correct_category}</span></p>
          )}
          {(feedback.created_by || feedback.created_at) && (
            <p className="text-muted/70">
              {feedback.created_by ?? '—'}{feedback.created_at ? `, ${formatDate(feedback.created_at)}` : ''}
            </p>
          )}
        </div>
      )}

      {/* Кнопки оценки — компактные иконки в одну строку справа */}
      <div className="flex justify-end gap-2">
        <button
          onClick={saveGood}
          disabled={submit.isPending || isDemo}
          title={isDemo ? 'Недоступно в демо-режиме' : 'Разобрано верно'}
          className={`flex items-center justify-center p-1.5 rounded-md border transition-colors disabled:opacity-40 ${
            feedback?.rating === 'good'
              ? 'border-green-500/60 bg-green-500/10 text-green-400'
              : 'border-border text-muted hover:text-green-400 hover:border-green-500/50'
          } ${isDemo ? 'cursor-not-allowed' : ''}`}
        >
          <ThumbsUp size={15} />
        </button>
        <button
          onClick={() => setShowBadForm(v => !v)}
          disabled={submit.isPending || isDemo}
          title={isDemo ? 'Недоступно в демо-режиме' : 'Ошибка разбора'}
          className={`flex items-center justify-center p-1.5 rounded-md border transition-colors disabled:opacity-40 ${
            feedback?.rating === 'bad' || showBadForm
              ? 'border-orange-500/60 bg-orange-500/10 text-orange-400'
              : 'border-border text-muted hover:text-orange-400 hover:border-orange-500/50'
          } ${isDemo ? 'cursor-not-allowed' : ''}`}
        >
          <ThumbsDown size={15} />
        </button>
      </div>

      {/* Форма «ошибка разбора» */}
      {showBadForm && !isDemo && (
        <div className="bg-frame border border-border rounded-md px-3 py-2.5 space-y-2">
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted/60 mb-1">Тип ошибки</label>
            <select
              value={errorKind}
              onChange={e => setErrorKind(e.target.value as import('../types').AiFeedbackErrorKind)}
              className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
            >
              {AI_ERROR_KINDS.map(k => (
                <option key={k.value} value={k.value} className="bg-card text-primary">{k.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted/60 mb-1">Комментарий</label>
            <textarea
              value={fbComment}
              onChange={e => setFbComment(e.target.value)}
              rows={2}
              placeholder="Что именно не так…"
              className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-xs resize-none focus:outline-none focus:border-accent leading-relaxed"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted/60 mb-1">Правильная категория (необязательно)</label>
            <input
              type="text"
              value={correctCategory}
              onChange={e => setCorrectCategory(e.target.value)}
              placeholder="напр. Глушение"
              className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
          </div>
          <button
            onClick={saveBad}
            disabled={submit.isPending}
            className={`flex items-center justify-center gap-1.5 w-full bg-orange-600/90 hover:bg-orange-500 text-white text-xs font-semibold py-1.5 rounded-lg transition-colors disabled:opacity-50 ${submit.isPending ? 'animate-pulse cursor-wait' : ''}`}
          >
            {submit.isPending ? <Working label="Сохраняю…" /> : <><Check size={14} /> Сохранить</>}
          </button>
        </div>
      )}

      {submit.isError && <p className="text-xs text-orange-400">Не удалось сохранить оценку. Попробуйте снова.</p>}
    </div>
  )
}

export function IssueDetail() {
  const { selectedIssueId, selectIssue, trackOpen, setTrackOpen, openTrack, lastTemplate, detailExpanded, setDetailExpanded } = useIssuesStore()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [commentPublic, setCommentPublic] = useState(true)
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  // Объект, чью телеметрию показывает блок ②. Выбирается кликом по строке разбора;
  // у одиночной заявки подставляется единственная строка.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [selectedObj, setSelectedObj] = useState<import('../types').BatchObject | null>(null)
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
  // Лента комментариев по умолчанию показывает только последний — старая
  // переписка нужна редко, а вся лента уводит блок «Ответ» далеко вверх.
  const [allComments, setAllComments] = useState(false)
  const visibleComments = allComments ? comments : comments.slice(-1)

  // Кол-во извлекаемых вложений для управления видимостью AutoAnalysis
  const { data: issueAttachments = [] } = useQuery({
    queryKey: ['attachments', selectedIssueId],
    queryFn: () => api.listAttachments(selectedIssueId!),
    enabled: selectedIssueId != null,
    staleTime: 5 * 60_000,
  })
  const extractableCount = issueAttachments.filter((a: import('../types').IssueAttachment) => a.extractable).length

  // Тот же ключ, что у AutoAnalysis: подписываемся на кэш анализа, чтобы блок
  // телеметрии знал уверенность и «можно авто» без подъёма состояния наверх.
  const { data: automateCached } = useQuery({
    queryKey: ['automate-cached', selectedIssueId],
    queryFn: () => api.getCachedAutomate(selectedIssueId!),
    enabled: selectedIssueId != null,
    staleTime: 5 * 60_000,
  })

  const addComment = useMutation({
    mutationFn: (text: string) => api.addComment(selectedIssueId!, text, commentPublic),
    onSuccess: () => {
      setComment('')
      queryClient.invalidateQueries({ queryKey: ['comments', selectedIssueId] })
    },
  })

  const quickResolve = useMutation({
    mutationFn: (statusCode: 'completed' | 'delayed' | 'wait') => {
      const delayTo = statusCode === 'delayed'
        ? (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 16) })()
        : undefined
      // «В работе» (wait) — смена статуса без обязательного ответа клиенту: комментарий
      // отправляем, только если оператор его написал.
      return api.resolveIssue(selectedIssueId!, statusCode, comment || undefined, delayTo, commentPublic)
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

  const { issue, okdesk_detail: od } = data

  const overdue = isOverdue(od?.deadline_at)
  const useBatch = isBatchIssue(issue, od?.description, extractableCount)
  // Уверенность и признак «можно авто» есть только у одиночного анализа: в пакетном
  // разборе бэкенд отдаёт по объекту вердикт и метрики, но не оценку уверенности.
  const singleAnalysis = automateCached?.cached ? (automateCached as unknown as AutomationResult) : null

  return (
    <>
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border shrink-0 bg-base z-20">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-muted text-xs font-mono">#{issue.external_id}</span>
            {od ? (
              <div className="relative">
                <button
                  onClick={() => !isDemo && setStatusDropdownOpen(v => !v)}
                  title={isDemo ? 'Недоступно в демо-режиме' : 'Изменить статус'}
                  className={`hover:opacity-75 transition-opacity ${isDemo ? 'cursor-not-allowed' : ''}`}
                >
                  <StatusBadge status={issue.status} />
                </button>
                {statusDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setStatusDropdownOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-md overflow-hidden shadow-lg border border-border min-w-[160px]">
                      {getAvailableStatuses(issue.status, od.type_code).map(s => (
                        <button
                          key={s.code}
                          onClick={() => { setStatusDropdownOpen(false); setPendingStatus(s) }}
                          className="w-full text-left px-4 py-2.5 text-xs font-medium hover:brightness-110 transition-all"
                          style={statusPillStyle(s.code)}
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
            {overdue && (
              <span
                title={`Срок: ${formatDate(od?.deadline_at) ?? '—'}`}
                className="inline-flex items-center gap-1 bg-warning/15 text-warning rounded-pill px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide"
              >
                <AlertTriangle size={10} /> Просрочено
              </span>
            )}
            {issue.company_name && (
              <>
                <span className="text-muted text-xs">·</span>
                <span className="text-xs text-secondary truncate">{issue.company_name}</span>
              </>
            )}
          </div>
          <h2 className="text-[15px] font-bold leading-snug">{issue.subject ?? '—'}</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setDetailExpanded(!detailExpanded)}
            title={detailExpanded ? 'Вернуть список заявок' : 'Развернуть карточку на всю ширину (две колонки)'}
            className={`flex items-center justify-center p-1.5 rounded-md border transition-colors ${detailExpanded ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:text-white hover:border-accent'}`}
          >
            {detailExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            onClick={() => trackOpen ? setTrackOpen(false) : openTrack()}
            title={trackOpen ? 'Скрыть карту и графики' : 'Карта трека и графики телеметрии'}
            className={`flex items-center justify-center p-1.5 rounded-md border transition-colors ${trackOpen ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:text-white hover:border-accent'}`}
          >
            {trackOpen ? <PanelRightClose size={15} /> : <Map size={15} />}
          </button>
          <button onClick={() => selectIssue(null)} title="Закрыть карточку" className="flex items-center justify-center p-1.5 text-muted hover:text-white"><X size={18} /></button>
        </div>
      </div>

      {/* Тело карточки. Раскладка v3: работа слева, контекст в рельсе справа.
          Две колонки включаются по ШИРИНЕ ПАНЕЛИ (container query в index.css),
          а не по ширине окна — рядом может быть открыта панель трека. */}
      <div className="flex-1 overflow-y-auto px-5 py-4 issue-body">
        {resolveNotice && (
          <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-md px-3 py-2 text-xs text-warning mb-4">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="flex-1">{resolveNotice}</span>
            <button onClick={() => setResolveNotice(null)} className="shrink-0 text-warning/60 hover:text-warning"><X size={14} /></button>
          </div>
        )}

        <div className="flex gap-4 issue-cols">
        {/* ── Левая колонка: работа оператора ──────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">
        {/* Вопрос клиента — исходный материал, до разбора ИИ */}
        <ClientQuestionBlock description={od?.description} />

        {/* ① Разбор — таблица объектов: одинаково для одного ТС и для двадцати */}
        <Block
          title="① Разбор"
          right={selectedObj?.plate ? <span className="text-xs text-muted">выбран {selectedObj.plate}</span> : undefined}
        >
          <BatchAnalysis
            key={issue.id}
            issueId={issue.id}
            issueTitle={issue.subject}
            issueDescription={od?.description}
            companyName={issue.company_name}
            onOpenExternal={openExternal}
            selectedIdx={selectedIdx}
            onSelectObject={(idx, objects) => { setSelectedIdx(idx); setSelectedObj(objects[idx] ?? null) }}
          />
          <SingleParseTable issueId={issue.id} onSelect={obj => { setSelectedIdx(0); setSelectedObj(obj) }} />
          <AutoAnalysis
            issueId={issue.id}
            issueTitle={issue.subject}
            companyName={issue.company_name}
          />
        </Block>

        {/* ② Телеметрия и вердикт — по объекту, выбранному в таблице выше */}
        <Block
          title="② Телеметрия и вердикт"
          right={selectedObj?.date ? <span className="text-xs text-muted">за {selectedObj.date}</span> : undefined}
        >
          <TelemetryPanel
            telemetry={selectedObj?.telemetry ?? null}
            category={selectedObj?.verdict ?? null}
            confidence={singleAnalysis?.confidence ?? null}
            needsReview={singleAnalysis?.needs_review ?? false}
            autoEligible={singleAnalysis?.auto_eligible}
            subtitle={selectedObj?.plate ?? null}
            reasoning={singleAnalysis?.reasoning ?? null}
          />
          {!selectedObj && (
            <p className="text-[13px] text-muted">
              Запустите разбор в блоке выше — телеметрия появится по выбранному объекту.
            </p>
          )}
          {/* Разборы, сделанные до появления telemetry в ответе бэкенда, метрик
              не содержат — объясняем, почему их нет, вместо пустого блока. */}
          {selectedObj && !selectedObj.telemetry && (
            <p className="text-[13px] text-muted">
              В сохранённом разборе метрик нет — нажмите «Обновить разбор» в блоке выше,
              чтобы пересчитать телеметрию по объектам.
            </p>
          )}
        </Block>

        {/* ③ Ответ: генерация черновика, шаблоны, композер */}
        <AnswerBlock
          issueId={issue.id}
          useBatch={useBatch}
          comment={comment}
          setComment={setComment}
          commentPublic={commentPublic}
          setCommentPublic={setCommentPublic}
          onSend={() => addComment.mutate(comment)}
          sending={addComment.isPending}
          isDemo={isDemo}
        />

        {/* Передать монтажнику — альтернативный исход заявки */}
        <InstallerExportSection issueId={issue.id} />

        {/* Комментарии — только лента: композер переехал в блок «Ответ» */}
        <Block icon={MessageSquare} title="Комментарии" count={comments.length > 0 ? comments.length : null}>
          <div className="space-y-2">
            {visibleComments.map(c => {
              const isClient = c.author_kind === 'client'
              const isSystem = c.author_kind === 'system'
              // is_internal is the legacy flag; is_public (new) takes precedence when present.
              const isInternal = c.is_public === false || (c.is_public == null && c.is_internal === true)
              // Авто-уведомления Okdesk (смена статуса и т.п.) — часто приходят от
              // сотрудника, но это не «живой» комментарий. Вместе с author_kind=system
              // объединяем в одну категорию «уведомление».
              // Фолбэк по тексту (основной детект — author_kind=system на бэкенде).
              // \w в JS НЕ матчит кириллицу — используем [а-яё], иначе «перешла»
              // не ловилось и уведомление красилось как комментарий сотрудника.
              const isAutoNotif = /перешл[а-яё]* в статус|изменил[а-яё]* статус|остал[а-яё]* вопрос[а-яё]* можете повторно|статус[а-яё]* заявки измен/i.test(c.content ?? '')
              const isNotification = isSystem || isAutoNotif
              const KindIcon = isClient ? User : isNotification ? Bot : Headset
              const kindLabel = isClient ? 'Клиент' : isAutoNotif ? 'Уведомление' : isSystem ? 'Система' : 'Сотрудник'
              // Системные уведомления — нейтральный серый, явно отличный от клиента
              // (синий) и сотрудника (бирюзовый). Приватный/внутренний комментарий
              // сохраняет свой пунктир-янтарь (важнее показать «не виден клиенту»),
              // а цвет автора остаётся в бейдже.
              const baseStyle = isInternal
                ? 'border border-dashed border-warning/50 bg-warning/5'
                : isNotification
                ? `bg-white/[0.04] border-l-2 border-muted/40${isAutoNotif ? ' opacity-80' : ''}`
                : isClient
                ? 'bg-frame border-l-2 border-info/60'
                : 'bg-card border-l-2 border-accent/40'
              return (
                <div
                  key={c.id}
                  className={`rounded-md px-3 py-2.5 text-xs space-y-1 ${baseStyle}`}
                >
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        title={kindLabel}
                        className={`inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide ${
                          isClient ? 'bg-info/15 text-info' : isNotification ? 'bg-white/10 text-muted' : 'bg-accent/15 text-accent'
                        }`}
                      >
                        <KindIcon size={10} /> {kindLabel}
                      </span>
                      <span className="font-medium text-white/70 truncate">{c.author}</span>
                      {isInternal && (
                        <span
                          title="Внутренний комментарий — не виден клиенту"
                          className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide bg-warning/15 text-warning"
                        >
                          <Lock size={10} /> Внутренний
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted" title="Дата и время комментария">{formatDate(c.created_at) ?? '—'}</span>
                  </div>
                  {/* Комментарии из Okdesk приходят с HTML (письма из Google Docs
                      тащат <strong id="docs-internal-guid-…">) — показывали сырые теги. */}
                  <p className={['leading-relaxed whitespace-pre-wrap', isNotification ? 'text-muted/80' : ''].join(' ')}>{stripHtml(c.content)}</p>
                </div>
              )
            })}
            {comments.length === 0 && <p className="text-xs text-muted">Комментариев нет</p>}
            {comments.length > 1 && (
              <button
                onClick={() => setAllComments(v => !v)}
                className="text-xs text-accent hover:underline"
              >
                {allComments ? 'Свернуть до последнего' : `Показать все ${comments.length} комментариев`}
              </button>
            )}
          </div>

        </Block>
        </div>

        {/* ── Правый рельс: контекст заявки ────────────────────── */}
        <div className="space-y-4 issue-rail">
          <Block title="Детали заявки">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <span className="text-muted">Компания</span>
              <span>{issue.company_name ?? '—'}</span>
              <span className="text-muted">Контакт</span>
              <span>{issue.contact_name ?? '—'}</span>
              <span className="text-muted">Создана</span>
              <span>{formatDate(issue.created_at) ?? '—'}</span>
            </div>

            {/* Live Okdesk info */}
            {od && <div className="mt-4"><OkdeskInfo d={od} issueId={issue.id} assigneeName={issue.assignee_name ?? null} /></div>}

            {/* Если okdesk_detail пустой — показываем только assignee picker */}
            {!od && (
              <div className="mt-4"><AssigneeSection issueId={issue.id} assigneeName={issue.assignee_name ?? null} /></div>
            )}
          </Block>

          <AttachmentsSection issueId={issue.id} />

          {od && <RelatedIssuesSection d={od} onOpenExternal={openExternal} />}

          <Block icon={Sparkles} title="Оценка разбора" right={<span className="text-xs text-muted">влияет на обучение ИИ</span>}>
            <AiFeedbackPanel issueId={issue.id} />
          </Block>
        </div>
        </div>
      </div>

      {/* ── Липкий бар действий: главное действие всегда на виду ── */}
      <div className="shrink-0 border-t border-border bg-card px-5 py-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted min-w-0 truncate">
          {comment
            ? commentPublic
              ? 'Ответ уйдёт клиенту публичным комментарием, заявка перейдёт в «Решена»'
              : 'Комментарий приватный — клиент его не увидит, заявка перейдёт в «Решена»'
            : 'Напишите ответ в блоке «Ответ», чтобы решить заявку'}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <button
              onClick={() => setMoreActionsOpen(v => !v)}
              disabled={isDemo}
              title={isDemo ? 'Недоступно в демо-режиме' : 'Другие переходы статуса'}
              className={`flex items-center gap-1 bg-frame border border-border hover:border-accent rounded-md px-3 py-2 text-[13px] font-medium text-secondary transition-colors disabled:opacity-40 ${isDemo ? 'cursor-not-allowed' : ''}`}
            >
              Ещё <ChevronDown size={13} />
            </button>
            {moreActionsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreActionsOpen(false)} />
                <div className="absolute right-0 bottom-full mb-1 z-50 w-[200px] rounded-md overflow-hidden border border-border bg-frame shadow-lg">
                  <button
                    disabled={quickResolve.isPending}
                    onClick={() => { setMoreActionsOpen(false); quickResolve.mutate('wait') }}
                    title="Перевести в «В работе» (комментарий необязателен)"
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-[13px] text-left hover:bg-card-hover disabled:opacity-40"
                  >
                    <Play size={13} style={{ color: STATUS_COLOR.wait }} /> В работе
                  </button>
                  <button
                    disabled={!comment || quickResolve.isPending}
                    onClick={() => { setMoreActionsOpen(false); quickResolve.mutate('delayed') }}
                    title="Отправить ответ и перевести в «Ожидание ответа» (+3 дня)"
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-[13px] text-left hover:bg-card-hover disabled:opacity-40"
                  >
                    <Pause size={13} style={{ color: STATUS_COLOR.delayed }} /> Ожидание ответа
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            disabled={!comment || quickResolve.isPending || isDemo}
            onClick={() => {
              if (!od?.type_code || od.type_code === 'inner') {
                setToast('Сначала укажите тип заявки')
                return
              }
              quickResolve.mutate('completed')
            }}
            title={isDemo ? 'Недоступно в демо-режиме' : 'Отправить ответ клиенту и перевести в «Решена»'}
            className={`flex items-center gap-1.5 bg-accent hover:bg-accent/90 text-black rounded-md px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-40 ${quickResolve.isPending && quickResolve.variables === 'completed' ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
          >
            {quickResolve.isPending && quickResolve.variables === 'completed'
              ? <Working label="Отправляю…" />
              : <><Check size={14} /> Ответить и решить</>}
          </button>
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

    {toast && (
      <div className="fixed bottom-5 right-5 z-[60] flex items-center gap-2 bg-warning text-black text-xs font-semibold px-4 py-2.5 rounded-lg shadow-lg">
        <AlertTriangle size={14} /> {toast}
      </div>
    )}
    </>
  )
}
