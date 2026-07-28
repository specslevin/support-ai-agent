import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo, useEffect, useRef, useId, createContext, useContext } from 'react'
import {
  ChevronDown, AlertTriangle, X, Check, Star, Bot, RefreshCw, Database,
  Lightbulb, Map, FilePlus, ExternalLink, Pause, Send,
  Layers, FileText,
  PanelRightClose, Info, MessageSquare, Sparkles, Wand2,
  Maximize2, Minimize2,
  Loader2, Lock, User, Headset, Play, ThumbsUp, ThumbsDown,
  Copy, Calendar, Phone, Pencil,
} from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useUserStore } from '../store/userStore'
import { useAuthStore } from '../store/authStore'
import { StatusBadge } from './StatusBadge'
import { EmployeeMenu, TypeMenu } from './pickers'
import type {
  OkdeskDetail, Template, AutomationResult, BatchResult, BatchObject, ParseResult,
  VerdictSource, IssueAttachment, RelatedIssue,
} from '../types'
import {
  extractPlaceholders, hasPlaceholders, renderTemplate,
  computedPlaceholderValue, isComputedPlaceholder,
} from '../lib/templates'
import { STATUS_COLOR, statusPillStyle } from '../lib/status'
import {
  TelemetryPanel, VerdictPill, VERDICT_TEXT_STYLE,
  normalizeVerdictSource, verdictSourceHint, verdictDisagreement,
} from './TelemetryPanel'

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

/**
 * Строка «ключ — значение» в «Деталях заявки» (макет .kv): подпись фиксированной
 * ширины, 1px-разделитель снизу. Раньше это была сетка 2 колонки, из-за чего
 * значения прыгали по горизонтали от длины подписи.
 */
function MetaRow({ label, title, children, action }: {
  label: string
  title?: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line py-[7px] last:border-b-0">
      <span
        title={title}
        className="w-[148px] shrink-0 text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted"
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 text-xs leading-[18px] text-secondary">{children}</span>
      {action}
    </div>
  )
}

/**
 * Раскрытие секций карточки (v4) — одно место в localStorage на все секции.
 * Нужно, чтобы при переключении заявок оператор не сворачивал/разворачивал
 * одно и то же заново: высота секции меняется ТОЛЬКО кликом по её заголовку.
 */
const SECTIONS_KEY = 'issueCardSections'

function readSectionState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/**
 * Секции тела карточки в визуальном порядке — нужен, чтобы при открытии заявки
 * выбрать активную по умолчанию. Раскрытость читаем из того же localStorage, что
 * и сами секции; «Вложения» и «Связанные» рендерятся не всегда (optional).
 */
const BODY_SECTIONS: { key: string; defaultOpen: boolean; optional?: boolean }[] = [
  { key: 'question', defaultOpen: true },
  { key: 'details', defaultOpen: false },
  { key: 'attachments', defaultOpen: false, optional: true },
  { key: 'parse', defaultOpen: true },
  { key: 'telemetry', defaultOpen: true },
  { key: 'feedback', defaultOpen: false },
  { key: 'comments', defaultOpen: true },
  { key: 'related', defaultOpen: true, optional: true },
  { key: 'installer', defaultOpen: false },
]

/**
 * Активная секция при открытии заявки — «Разбор»: с него начинается работа
 * (вердикт + таблица объектов), глаз должен сразу ловить главное. Дальше полоса
 * едет за кликами. Если «Разбор» свёрнут (оператор мог закрыть его в прошлой
 * сессии), висеть на свёрнутой секции полосе нельзя — падаем на первую
 * раскрытую сверху вниз; раскрытых нет — не подсвечиваем ничего.
 */
function initialActiveSection(present: { attachments: boolean; related: boolean }): string | null {
  const saved = readSectionState()
  const isOpen = (s: typeof BODY_SECTIONS[number]) => {
    if (s.optional && !present[s.key as keyof typeof present]) return false
    const stored = saved[s.key]
    return typeof stored === 'boolean' ? stored : s.defaultOpen
  }
  const parse = BODY_SECTIONS.find(s => s.key === 'parse')
  if (parse && isOpen(parse)) return parse.key
  return BODY_SECTIONS.find(isOpen)?.key ?? null
}

/**
 * Активная секция (v4) — «ты сейчас здесь». Лаймовая полоса слева и акцентный
 * заголовок горят ровно у ОДНОЙ секции: у той, которую оператор трогал
 * последней. Раскрытых секций легко бывает 5-6 сразу, и подсветка каждой
 * убивала приём. Раскрытость к активности отношения не имеет — она по-прежнему
 * своя у каждой секции и живёт в localStorage.
 */
const ActiveSectionContext = createContext<{
  active: string | null
  /** Пометить секцию активной (раскрыли её или кликнули внутрь). */
  activate: (id: string) => void
  /** Свернули секцию: снять подсветку, если горела именно она. */
  clear: (id: string) => void
}>({ active: null, activate: () => {}, clear: () => {} })

function useSectionOpen(storageKey: string | undefined, defaultOpen: boolean, forceOpen?: string | number | null) {
  // Секции без storageKey всё равно должны различаться в контексте активной.
  const fallbackId = useId()
  const id = storageKey ?? fallbackId
  const { active, activate, clear } = useContext(ActiveSectionContext)
  const [open, setOpen] = useState<boolean>(() => {
    if (!storageKey) return defaultOpen
    const saved = readSectionState()[storageKey]
    return typeof saved === 'boolean' ? saved : defaultOpen
  })
  // Разовое навязанное раскрытие (см. проп forceOpen у Block): срабатывает один
  // раз на значение-ключ — свернул оператор руками, значит больше не навязываем;
  // сменилась заявка (ключ другой) — навязываем заново. В localStorage не пишем:
  // сохранённый выбор оператора этим раскрытием не затирается.
  const forcedRef = useRef<string | number | null>(null)
  useEffect(() => {
    if (forceOpen == null || forcedRef.current === forceOpen) return
    forcedRef.current = forceOpen
    setOpen(true)
  }, [forceOpen])
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (storageKey) {
      const all = readSectionState()
      all[storageKey] = next
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(all)) } catch { /* приватный режим */ }
    }
    if (next) activate(id)
    else clear(id)
  }
  /** Клик внутрь раскрытой секции — тоже «я сейчас здесь». */
  const focus = () => { if (open) activate(id) }
  return { open, toggle, focus, isActive: open && active === id }
}

/** Строка-заголовок секции: 9px uppercase, счётчик-пилюля, шеврон справа. */
function SectionHead({ title, count, right, open, active, toggle, className = '' }: {
  title: string
  count?: number | string | null
  right?: React.ReactNode
  open: boolean
  /** Секция, с которой оператор работает прямо сейчас (одна на карточку). */
  active: boolean
  toggle: () => void
  className?: string
}) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        onClick={toggle}
        title={open ? `Свернуть «${title}»` : `Раскрыть «${title}»`}
        className="flex flex-1 min-w-0 items-center gap-2 text-left"
      >
        <span className={`text-[9px] font-medium uppercase tracking-[0.4px] leading-3 transition-colors ${active ? 'text-accent' : 'text-muted hover:text-secondary'}`}>
          {title}
        </span>
        {count != null && count !== '' && (
          <span className="shrink-0 rounded-pill bg-white/[0.08] px-[7px] py-px text-[11px] font-medium leading-4 text-muted tabular-nums">
            {count}
          </span>
        )}
      </button>
      {right && <div className="shrink-0 min-w-0 text-[11px] text-muted">{right}</div>}
      <button
        onClick={toggle}
        title={open ? `Свернуть «${title}»` : `Раскрыть «${title}»`}
        className="shrink-0 text-muted hover:text-secondary transition-colors"
      >
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  )
}

/**
 * Сворачиваемая под-секция внутри блока (v4): тот же вид, что у Block, но без
 * внешних отступов-карточки — только 1px-разделитель и лаймовая полоса слева
 * у активной (см. ActiveSectionContext).
 */
function Section({ title, children, defaultOpen = true, storageKey }: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  storageKey?: string
}) {
  const { open, toggle, focus, isActive } = useSectionOpen(storageKey, defaultOpen)
  return (
    <div
      onMouseDownCapture={focus}
      className={`border-b border-line last:border-b-0 border-l-2 py-2 pl-2.5 ${isActive ? 'border-l-accent' : 'border-l-transparent'}`}
    >
      <SectionHead title={title} open={open} active={isActive} toggle={toggle} />
      {open && <div className="pt-2 space-y-2">{children}</div>}
    </div>
  )
}

/**
 * Секция карточки заявки (макет v4 «плоские строки»): без подложки и радиусов,
 * фон остаётся общим (bg-base). Отделяется 1px-линией снизу; АКТИВНАЯ (последняя,
 * с которой работал оператор) помечена лаймовой полосой 2px слева, остальные —
 * прозрачной полосой той же ширины, чтобы текст не дёргался по горизонтали.
 */
function Block({ title, count, right, children, defaultOpen = true, storageKey, forceOpen }: {
  title: string
  count?: number | string | null
  right?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  /** Ключ для запоминания раскрытия в localStorage (не сбрасывается между заявками). */
  storageKey?: string
  /**
   * Разово раскрыть секцию, когда в ней ждёт обязательное действие (напр. не
   * указан тип заявки). Значение — ключ навязывания: своё на заявку, чтобы
   * повтор случился у другой заявки, но не после ручного сворачивания.
   */
  forceOpen?: string | number | null
}) {
  const { open, toggle, focus, isActive } = useSectionOpen(storageKey, defaultOpen, forceOpen)
  return (
    <section
      onMouseDownCapture={focus}
      className={`border-b border-line border-l-2 py-2.5 pr-4 pl-[14px] ${isActive ? 'border-l-accent' : 'border-l-transparent'}`}
    >
      <SectionHead title={title} count={count} right={right} open={open} active={isActive} toggle={toggle} />
      {open && <div className="pt-2.5 space-y-2.5">{children}</div>}
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

/**
 * «Передать монтажникам»: два формата (КАЛЕНДАРЬ / МЕССЕНДЖЕР) в один клик.
 * Живёт последней секцией карточки (см. InstallerSection); логика в хуке, чтобы
 * текст собирался ТОЛЬКО по клику на формат — ни монтаж, ни раскрытие секции
 * запросов не делают (принцип проекта: ИИ и сборка данных работают по кнопке).
 */
function useInstallerExport(issueId: number) {
  const [copied, setCopied] = useState<'calendar' | 'messenger' | null>(null)
  // Формат, запрошенный последним: его текст показываем инлайн внутри секции.
  const [shown, setShown] = useState<'calendar' | 'messenger' | null>(null)

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
    setShown(kind)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1800)
  }

  return { data, isFetching, isError, copied, shown, handleCopy }
}

const INSTALLER_FORMATS = [
  { kind: 'calendar', label: 'Календарь', icon: Calendar, hint: 'формат для карточки в календаре' },
  { kind: 'messenger', label: 'Мессенджер', icon: MessageSquare, hint: 'формат для сообщения в мессенджере' },
] as const

/**
 * «Передать монтажникам» — последняя секция карточки (v4). Текст собирается по
 * клику на формат: сразу уходит в буфер и остаётся инлайн, чтобы оператор видел,
 * что именно скопировал, и мог скопировать повторно.
 */
function InstallerSection({ issueId }: { issueId: number }) {
  const { data, isFetching, isError, copied, shown, handleCopy } = useInstallerExport(issueId)
  const text = shown && data ? (shown === 'calendar' ? data.calendar : data.messenger) : null
  const shownLabel = INSTALLER_FORMATS.find(f => f.kind === shown)?.label ?? ''

  return (
    <Block title="Передать монтажникам" storageKey="installer" defaultOpen={false}>
      <p className="text-[11px] leading-4 text-secondary">
        Готовый текст с адресом, техникой и контактом. Собирается по кнопке формата и сразу копируется в буфер.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {INSTALLER_FORMATS.map(f => (
          <button
            key={f.kind}
            onClick={() => handleCopy(f.kind)}
            disabled={isFetching}
            title={copied === f.kind ? 'Скопировано' : `Собрать и скопировать текст монтажнику — ${f.hint}`}
            className="flex items-center justify-center gap-1.5 bg-frame border border-border hover:border-accent rounded-md px-3 py-1.5 text-xs font-semibold text-muted hover:text-accent transition-colors disabled:opacity-40"
          >
            {copied === f.kind
              ? <Check size={13} className="text-success" />
              : isFetching
              ? <Loader2 size={13} className="animate-spin" />
              : <f.icon size={13} />}
            {f.label}
          </button>
        ))}
      </div>
      {isError && (
        <p className="text-[11px] text-orange-400">Не удалось собрать данные для монтажника. Попробуйте ещё раз.</p>
      )}
      {text && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-medium uppercase tracking-[0.4px] text-muted">{shownLabel}</span>
            <button
              onClick={() => copyToClipboard(text)}
              title="Скопировать текст ещё раз"
              className="ml-auto flex items-center gap-1 text-[11px] text-muted hover:text-accent transition-colors"
            >
              <Copy size={12} /> Скопировать
            </button>
          </div>
          <p className="text-[11px] text-white whitespace-pre-wrap break-words bg-frame border border-border rounded-md px-3 py-2 leading-relaxed">{text}</p>
          {text.includes('____') && (
            <p className="text-[10px] text-muted/70">
              Прочерки «____» — поля не найдены в заявке, дозаполните вручную перед отправкой.
            </p>
          )}
        </div>
      )}
    </Block>
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
    <MetaRow
      label="Ответственный"
      title="assignee — сотрудник, ведущий заявку в Okdesk"
      action={
        <div className="flex shrink-0 items-center gap-1.5">
          {assignMutation.isPending && (
            <span className="animate-pulse text-[10px] text-muted">Сохраняю…</span>
          )}
          {currentUser && currentUser.name !== assigneeName && (
            <button
              onClick={() => assignMutation.mutate(currentUser.id)}
              disabled={assignMutation.isPending}
              title={`Назначить заявку на себя (${currentUser.name})`}
              className="rounded-pill border border-border bg-frame px-3 py-[3px] text-[11px] font-medium text-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            >
              Взять себе
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setPickerOpen(o => !o)}
              disabled={assignMutation.isPending}
              title="Выбрать другого ответственного"
              className="flex items-center rounded-pill border border-border bg-frame px-2 py-[3px] text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            >
              <ChevronDown size={13} />
            </button>
            {pickerOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-card py-1 shadow-lg">
                  <EmployeeMenu selectedName={assigneeName} onPick={emp => assignMutation.mutate(emp.id)} />
                </div>
              </>
            )}
          </div>
        </div>
      }
    >
      <span className={assigneeName ? 'font-medium text-white' : 'text-muted/50'}>
        {assigneeName ?? 'Не назначен'}
      </span>
    </MetaRow>
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
    <MetaRow
      label="Тип заявки"
      title="type — от типа зависят доступные статусы и шаблоны; без типа Okdesk не пустит заявку ни в «В работе», ни в «Решена»"
      action={
        <div className="relative shrink-0">
          <button
            onClick={() => setOpen(o => !o)}
            title="Сменить тип заявки"
            className="rounded-pill border border-border bg-frame px-3 py-[3px] text-[11px] font-medium text-secondary transition-colors hover:border-accent hover:text-accent"
          >
            Изменить
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 max-h-72 min-w-[200px] overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg">
                <TypeMenu selectedCode={typeCode} onPick={t => { mutation.mutate(t.code); setOpen(false) }} />
              </div>
            </>
          )}
        </div>
      }
    >
      <span className={`inline-flex items-center gap-1 ${isDefault ? 'text-warning' : 'font-medium text-white'}`}>
        {isDefault && !mutation.isPending && <AlertTriangle size={12} className="shrink-0" />}
        {mutation.isPending ? 'Меняю…' : isDefault ? 'Не указан — выберите тип' : typeName}
      </span>
    </MetaRow>
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

  const filled = EDITABLE_PARAMS.filter(ep => (vals[ep.code] ?? '').trim()).length

  return (
    <Section title="Параметры заявки" defaultOpen={false} storageKey="params">
      <div>
        {EDITABLE_PARAMS.map(ep => (
          <div key={ep.code} className="flex items-center gap-2.5 border-b border-line py-[7px]">
            <span className="w-[148px] shrink-0 text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">
              {ep.label}
            </span>
            {/* Тихий inline-edit (макет .inl): поле выглядит текстом, обводка
                появляется по клику — «параметры Okdesk», а не форма-анкета. */}
            <input
              type="text"
              value={vals[ep.code] ?? ''}
              onChange={e => setVals(v => ({ ...v, [ep.code]: e.target.value }))}
              disabled={isDemo || mutation.isPending}
              placeholder="не заполнено — Okdesk не пустит в «В работе»"
              title={isDemo
                ? 'Недоступно в демо-режиме'
                : `Параметр Okdesk «${ep.label}» (${ep.code})`}
              className="-ml-2 min-w-0 flex-1 rounded-pill border border-transparent bg-transparent px-2 py-[3px] text-xs leading-[18px] text-white outline-none transition-colors placeholder:text-warning hover:border-line focus:border-accent focus:bg-frame disabled:cursor-not-allowed disabled:opacity-55"
            />
          </div>
        ))}
        {otherParams.map(p => (
          <MetaRow key={p.name} label={p.name}>{p.value}</MetaRow>
        ))}
      </div>
      {mutation.isError && (
        <p className="text-danger text-[11px]">
          {(mutation.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Не удалось сохранить параметры'}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] leading-4 text-muted">
          {mutation.isSuccess && !dirty
            ? '✓ параметры сохранены в Okdesk'
            : dirty ? 'есть несохранённые правки' : `заполнено ${filled} из ${EDITABLE_PARAMS.length}`}
        </span>
        <button
          onClick={() => mutation.mutate()}
          disabled={isDemo || mutation.isPending || !dirty}
          title={isDemo ? 'Недоступно в демо-режиме' : 'Сохранить параметры в Okdesk'}
          className={`flex shrink-0 items-center gap-1.5 rounded-pill bg-accent px-3 py-[5px] text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40 ${mutation.isPending ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
        >
          {mutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {mutation.isPending ? 'Сохраняю…' : 'Сохранить параметры'}
        </button>
      </div>
      {/* Почему пустое поле подсвечено предупреждением, а не прочерком. */}
      <p className="text-[10px] leading-4 text-muted">
        Пустые «Местоположение техники», «Контактное лицо» или «Номер телефона» блокируют перевод
        заявки в «В работе» — Okdesk отдаёт ошибку валидации. Правки уходят в Okdesk, а не только в кэш.
      </p>
    </Section>
  )
}

// Связанные заявки отсюда вынесены в RelatedIssuesSection (блок рельса v3),
// поэтому onOpenExternal этому компоненту больше не нужен.
function OkdeskInfo({ d, issueId, assigneeName }: { d: OkdeskDetail; issueId: number; assigneeName: string | null }) {
  const deadline = formatDate(d.deadline_at)
  const overdue = isOverdue(d.deadline_at)

  return (
    <div className="text-xs">
      {/* Участники. Тип и ответственный — первыми: без типа заявку не решить,
          а ответственный определяет, кто её ведёт. */}
      <Section title="Участники" storageKey="people">
        <div>
          <TypeSection issueId={issueId} typeName={d.type_name} typeCode={d.type_code} />
          <AssigneeSection issueId={issueId} assigneeName={assigneeName} />
          {d.author_name && (
            <MetaRow label="Автор" title="author_name — кто создал заявку в Okdesk">{d.author_name}</MetaRow>
          )}
          {d.service_object_name && (
            <MetaRow label="Объект обслуживания" title="service_object_name — объект обслуживания в Okdesk">
              {d.service_object_name}
            </MetaRow>
          )}
          {d.source && (
            <MetaRow label="Источник" title="source — откуда пришла заявка в Okdesk">{d.source}</MetaRow>
          )}
        </div>
      </Section>

      {/* Сроки */}
      <Section title="Сроки" defaultOpen={false} storageKey="dates">
        <div>
          {deadline && (
            <MetaRow label="Срок выполнения" title="deadline_at — срок выполнения по SLA">
              <span className={`inline-flex items-center gap-1 ${overdue ? 'text-orange-400' : ''}`}>
                {deadline} {overdue && <AlertTriangle size={11} />}
              </span>
            </MetaRow>
          )}
          {d.planned_reaction_at && (
            <MetaRow label="Плановая реакция" title="planned_reaction_at — когда по SLA надо было ответить">
              {formatDate(d.planned_reaction_at)}
            </MetaRow>
          )}
          {d.reacted_at && (
            <MetaRow label="Фактическая реакция" title="reacted_at — когда ответили фактически">
              {formatDate(d.reacted_at)}
            </MetaRow>
          )}
          {d.spent_time_total != null && d.spent_time_total > 0 && (
            <MetaRow label="Потрачено" title="spent_time_total — суммарные трудозатраты по заявке">
              {d.spent_time_total} ч.
            </MetaRow>
          )}
          {/* Прочерки вместо скрытия: пустое «отложена до» — тоже факт. */}
          <MetaRow
            label="Отложена до · завершена"
            title="delayed_to / completed_at — заполняются, когда заявка отложена или завершена"
          >
            {formatDate(d.delayed_to) ?? '—'} · {formatDate(d.completed_at) ?? '—'}
          </MetaRow>
        </div>
      </Section>

      {/* Параметры заявки (редактируемые custom fields) */}
      <EditableParameters d={d} issueId={issueId} />

    </div>
  )
}

/**
 * Вопрос клиента — первая секция потока (v4). Исходный материал работы, а не
 * свойство заявки, поэтому он до разбора ИИ. Сворачивание — общее, кликом по
 * заголовку секции (см. Block).
 */
function ClientQuestionBlock({ description, source, createdAt }: {
  description: string | null | undefined
  source?: string | null
  createdAt?: string | null
}) {
  const text = stripHtml(description)
  // Подпись-счётчик как в макете: «письмо · 23.07 09:40».
  const label = [source || null, formatDate(createdAt)].filter(Boolean).join(' · ')
  return (
    <Block title="Вопрос клиента" count={label || null} storageKey="question">
      <p className="text-[13px] leading-[18px] text-secondary whitespace-pre-wrap">
        {text || <span className="text-muted/60">Текст отсутствует — см. тему и параметры заявки</span>}
      </p>
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
  // Бэкенд отдаёт связи со статусом и темой (`related`); старые ответы без этого
  // поля собираем из id — связь важнее подписи.
  const related: RelatedIssue[] = d.related?.length
    ? d.related
    : [
        ...(d.parent_id ? [{ external_id: d.parent_id, role: 'parent' as const, subject: null, status: null, url: null }] : []),
        ...d.child_ids.map(id => ({ external_id: id, role: 'child' as const, subject: null, status: null, url: null })),
      ]
  const parents = related.filter(r => r.role === 'parent')
  const children = related.filter(r => r.role === 'child')

  const row = (r: RelatedIssue) => (
    <div key={`${r.role}-${r.external_id}`} className="flex items-center gap-2 border-b border-line py-[7px] last:border-b-0">
      <button
        onClick={() => onOpenExternal(r.external_id)}
        title={`Открыть заявку №${r.external_id} в карточке`}
        className="shrink-0 text-xs font-medium leading-[18px] text-white tabular-nums hover:underline"
      >
        №{r.external_id}
      </button>
      {r.status && <StatusBadge status={r.status} />}
      <span className="min-w-0 flex-1 truncate text-xs leading-[18px] text-muted" title={r.subject ?? undefined}>
        {r.subject ?? 'тема неизвестна — заявки нет в локальном кэше'}
      </span>
      {r.url && (
        <a
          href={r.url}
          target="_blank"
          rel="noreferrer"
          title={`Открыть заявку №${r.external_id} в Okdesk`}
          className="shrink-0 text-muted hover:text-accent transition-colors"
        >
          <ExternalLink size={12} />
        </a>
      )}
    </div>
  )

  return (
    <Block title="Связанные заявки" count={total} storageKey="related">
      {parents.length > 0 && (
        <div>
          <span className="mb-0.5 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">Родительская</span>
          {parents.map(row)}
        </div>
      )}
      {children.length > 0 && (
        <div>
          <span className="mb-0.5 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">
            Дочерние ({children.length})
          </span>
          {children.map(row)}
        </div>
      )}
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

export function TemplatePicker({ onSelect, onSelectFull, issueId, trigger = 'icon' }: {
  onSelect: (content: string) => void
  onSelectFull?: (t: { name: string; content: string }) => void
  issueId?: number
  /** 'icon' — компактная иконка (модалки, bulk); 'text' — кнопка «Шаблон ▾» в липком баре v4. */
  trigger?: 'icon' | 'text'
}) {
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

  const closePicker = () => {
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

  // Кнопка «Шаблон ▾» в липком баре: панель раскрывается НАД баром (инлайн-поп),
  // а не центральной модалкой — оператор видит поле ответа и подставляемый текст
  // одновременно. Модалка для этого закрывала весь экран.
  if (trigger === 'text') {
    const names = fill ? extractPlaceholders(fill.tpl.content) : []
    const preview = fill ? renderTemplate(fill.tpl.content, fill.values) : ''
    return (
      <div className="relative shrink-0">
        <button
          onClick={() => (open ? closePicker() : setOpen(true))}
          title="Выбрать шаблон ответа — шаблон с плейсхолдерами запросит значения"
          className={`flex shrink-0 items-center gap-1 rounded-pill border px-3 py-[5px] text-xs font-medium transition-colors ${
            open ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-frame text-secondary hover:border-muted hover:text-white'
          }`}
        >
          Шаблон <ChevronDown size={12} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={closePicker} />
            <div className="absolute bottom-full right-0 z-50 mb-2 w-[452px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-darker shadow-lg">
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5 text-xs font-medium">
                <span>{fill ? fill.tpl.name : 'Шаблоны ответов'}</span>
                <button onClick={closePicker} title="Закрыть панель шаблонов" className="text-muted hover:text-white">
                  <X size={14} />
                </button>
              </div>

              {!fill && (
                <>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5">
                    <input
                      autoFocus
                      type="text"
                      placeholder="Поиск по названию или тексту…"
                      title="Поиск по названию и тексту шаблона"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      className="min-w-0 flex-1 rounded-pill border border-border bg-frame px-3 py-1.5 text-xs outline-none focus:border-accent"
                    />
                    {categoryNames.length > 0 && (
                      <select
                        value={catFilter}
                        onChange={e => setCatFilter(e.target.value)}
                        title="Фильтр по категории шаблона"
                        className="shrink-0 max-w-[40%] rounded-pill border border-border bg-frame px-2.5 py-1.5 text-xs outline-none focus:border-accent"
                      >
                        <option value="">Все категории</option>
                        {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="mt-2.5 max-h-[232px] overflow-y-auto">
                    {visible.length === 0 && <p className="px-3 py-2.5 text-[11px] text-muted">Шаблоны не найдены</p>}
                    {visible.map(t => (
                      <button
                        key={t.id}
                        onClick={() => handleSelect(t)}
                        title={t.content.slice(0, 140)}
                        className="flex w-full items-center gap-2 border-b border-line px-3 py-[7px] text-left last:border-b-0 hover:bg-card-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs font-medium leading-[18px] text-white">
                          {t.is_favorite && <Star size={10} className="mr-1 inline fill-warning text-warning" />}
                          {t.name}
                        </span>
                        {t.category_name && <SumBadge title="Категория шаблона">{t.category_name}</SumBadge>}
                        {(t.is_dynamic || hasPlaceholders(t.content)) && (
                          <SumBadge title="Динамический шаблон — запросит значения плейсхолдеров">дин.</SumBadge>
                        )}
                        {t.usage_count > 0 && (
                          <span title={`Использован ${t.usage_count} раз`} className="shrink-0 rounded-pill bg-white/[0.08] px-[7px] text-[11px] leading-4 text-muted tabular-nums">
                            {t.usage_count}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {fill && (
                <>
                  <div className="max-h-[300px] space-y-2.5 overflow-y-auto px-3 py-2.5">
                    {names.map(name => {
                      // [сегодня]/[вчера]/[завтра] считаются по МСК и правке не подлежат:
                      // редактируемое поле создавало иллюзию, что дату можно сдвинуть.
                      const computed = isComputedPlaceholder(name)
                      return (
                        <div key={name}>
                          <span className="mb-1 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">[{name}]</span>
                          <input
                            autoFocus={name === names[0] && !computed}
                            type="text"
                            value={fill.values[name] ?? ''}
                            disabled={computed}
                            onChange={e => setFill(f => f && { ...f, values: { ...f.values, [name]: e.target.value } })}
                            title={computed
                              ? 'Подставляется автоматически по МСК'
                              : 'Значение подставлено из разбора заявки — можно поправить'}
                            className="w-full rounded-pill border border-border bg-frame px-3 py-1.5 text-xs outline-none focus:border-accent disabled:opacity-55"
                          />
                        </div>
                      )
                    })}
                    <div>
                      <span className="mb-1 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">Предпросмотр</span>
                      <p className="whitespace-pre-wrap rounded-xl border border-border bg-frame px-3 py-2 text-[11px] leading-relaxed text-white">{preview}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
                    <span title="[сегодня], [вчера], [завтра] подставляются автоматически по МСК" className="mr-auto text-[10px] leading-[14px] text-muted">
                      [сегодня] / [вчера] / [завтра] — автоподстановка
                    </span>
                    <button
                      onClick={() => setFill(null)}
                      title="Вернуться к списку шаблонов"
                      className="rounded-pill border border-border bg-frame px-3 py-[5px] text-xs font-medium text-secondary hover:border-muted hover:text-white"
                    >
                      Назад
                    </button>
                    <button
                      onClick={() => emit(fill.tpl, renderTemplate(fill.tpl.content, fill.values))}
                      title="Вставить готовый текст в поле ответа"
                      className="flex items-center gap-1.5 rounded-pill bg-accent px-3 py-[5px] text-xs font-medium text-black hover:opacity-90"
                    >
                      <Check size={13} /> Вставить
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

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

/**
 * Пункты меню «Ещё» в липком баре. Каждый ведёт в модалку смены статуса —
 * раньше «В работе» и «Ожидание ответа» отправлялись сразу, причём дата возврата
 * подставлялась молча (+3 дня), а обязательный комментарий Okdesk мог оказаться
 * пустым. Подписи объясняют требования ДО нажатия.
 */
const BAR_MENU_ACTIONS: { code: string; label: string; hint: string }[] = [
  { code: 'wait', label: 'В работе', hint: 'только для выездных типов' },
  { code: 'delayed', label: 'Ожидание ответа', hint: 'комментарий + отложить до' },
  { code: 'no_time', label: 'Нет времени', hint: 'комментарий + дата возврата' },
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

/**
 * Публичный / Приватный — сегмент видимости комментария (v4). Один компонент на
 * липкий бар и модалку статуса: раньше в баре были пилюли, а в модалке чекбокс.
 */
function VisibilitySegments({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex w-fit shrink-0 items-center rounded-pill border border-border bg-frame p-0.5">
      {([true, false] as const).map(pub => (
        <button
          key={String(pub)}
          onClick={() => onChange(pub)}
          title={pub ? 'Публичный — виден клиенту' : 'Внутренний комментарий — не виден клиенту'}
          className={`rounded-pill px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
            value === pub
              ? pub ? 'bg-accent/15 text-accent' : 'bg-warning/15 text-warning'
              : 'text-muted hover:text-white'
          }`}
        >
          {pub ? 'Публичный' : 'Приватный'}
        </button>
      ))}
    </div>
  )
}

// Modal shown after picking a status — comment + optional delay_to
function StatusActionModal({
  issueId,
  externalId,
  targetStatus,
  typeMissing = false,
  initialComment = '',
  initialPublic = true,
  onClose,
  onDone,
}: {
  issueId: number
  externalId: number
  targetStatus: typeof ALL_STATUSES[number]
  /** Тип заявки «Не указан» — Okdesk отклонит смену статуса, гард в модалке. */
  typeMissing?: boolean
  /** Текст и видимость, набранные в липком баре: переносим, а не заставляем перепечатывать. */
  initialComment?: string
  initialPublic?: boolean
  onClose: () => void
  onDone: (notice?: string) => void
}) {
  const queryClient = useQueryClient()
  const [comment, setComment] = useState(initialComment)
  const [commentPublic, setCommentPublic] = useState(initialPublic)
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

  const canSubmit = !typeMissing
    && (!targetStatus.commentRequired || comment.trim())
    && (!targetStatus.needsDelay || delayTo)

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
          {/* Гард, а не тост после отказа: Okdesk отклоняет смену статуса при
              type_code = inner, и узнать об этом надо ДО нажатия. */}
          {typeMissing && (
            <div className="flex items-start gap-2 rounded-md bg-warning/15 px-3 py-2 text-[11px] leading-4 text-warning">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              <span>Сначала укажите тип заявки — в разделе «Детали заявки». Без типа Okdesk не примет смену статуса.</span>
            </div>
          )}
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
            {/* Тот же сегмент, что в липком баре: один орган управления на всё
                приложение, а не чекбокс здесь и пилюли там. */}
            <VisibilitySegments value={commentPublic} onChange={setCommentPublic} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="text-xs text-muted hover:text-white transition-colors">Отмена</button>
          <button
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
            style={canSubmit && !mutation.isPending ? statusPillStyle(targetStatus.code) : undefined}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold border transition-opacity disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-frame disabled:border-border disabled:text-white ${mutation.isPending ? 'animate-pulse cursor-wait' : ''}`}
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

/**
 * Мультиобъектная («общая») заявка или одиночная. Один расчёт на карточку:
 * одиночный анализ и одиночная таблица разбора обязаны прятаться там, где
 * заявку ведёт пакетный разбор, иначе оператор увидит первый ТС из двадцати.
 * Оба запроса — те же ключи, что у остальных блоков: сети это не добавляет.
 */
function useBatchMode(issueId: number, issueTitle?: string | null, companyName?: string | null) {
  const attachQ = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })
  const extractCount = (attachQ.data ?? []).filter(a => a.extractable).length
  const cachedBatchQ = useQuery({
    queryKey: ['batch-cached', issueId],
    queryFn: () => api.getCachedBatch(issueId),
    enabled: extractCount >= 1,
    staleTime: 5 * 60_000,
  })
  const looksAggregate = /одкр/i.test(companyName ?? '') || /общ|одкр/i.test(issueTitle ?? '')
  const cachedBatch = cachedBatchQ.data?.cached ? cachedBatchQ.data : null
  const cachedBatchObjects = cachedBatch?.objects?.length ?? 0
  const isBatch = extractCount >= 2
    || (extractCount >= 1 && looksAggregate)
    || !!(cachedBatch && cachedBatch.is_aggregate)
    || cachedBatchObjects >= 2
  // Признак «данные для решения уже собраны»: пока запросы летят, режим неизвестен
  // и стрелять разбором нельзя (для пакетной заявки он взял бы не те данные).
  const ready = attachQ.isSuccess && (extractCount < 1 || cachedBatchQ.isSuccess)
  return { isBatch, ready, extractCount, cachedBatch, cachedBatchObjects }
}

/**
 * БЕСПЛАТНЫЙ разбор фактов для карточки: сначала кэш (GET — мгновенно), и только
 * если его нет — детерминированный пересчёт (POST без `attachments`, то есть без
 * OCR и без единого токена DeepSeek). Именно он наполняет таблицу до того, как
 * оператор нажмёт платную кнопку ИИ. Ни `automate`, ни `compose_answer` здесь нет.
 */
function useFreeParse(issueId: number, enabled = true) {
  return useQuery<ParseResult & { cached?: boolean; created_at?: string }>({
    queryKey: ['parse-free', issueId],
    queryFn: async () => {
      const cached = await api.getCachedParse(issueId)
      if (cached.cached) return cached
      return api.parseIssue(issueId)
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/** Бейдж-капслок сводки (макет .badge): «ИИ не вызывался» и подобные пометки. */
function SumBadge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center rounded-[4px] bg-white/[0.08] px-1.5 py-0.5 text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted"
    >
      {children}
    </span>
  )
}

/**
 * Источник вердикта строки разбора. Кэши, сделанные до появления `verdict_source`,
 * ручную правку помечали только флагом `verdict_edited` — учитываем и его, иначе
 * правка оператора выглядела бы как вердикт правил.
 */
function rowVerdictSource(o: BatchObject): VerdictSource {
  return normalizeVerdictSource(o.verdict_source ?? (o.verdict_edited ? 'operator' : undefined))
}

/** Тултип ячейки вердикта: откуда он взялся + что даст ручная правка. */
function verdictCellHint(o: BatchObject): string {
  return `${verdictSourceHint(rowVerdictSource(o))}. Изменить вручную — источник станет «оператор»`
}

const VERDICT_ORDER = [
  'Глушение', 'Данные верны', 'Не было питания', 'Терминал подключился',
  'Изменили настройки', 'Проверить', 'Нет данных', 'Объект не найден',
  'Номер не распознан', 'Нет номера/даты', 'Ошибка данных',
]

/**
 * Сводка разбора: «Всего N: вердикт × k» + бейдж «ИИ не вызывался», пока ни один
 * вердикт в таблице не получен от DeepSeek. Одна реализация на обе таблицы.
 */
function ParseSummary({ objects, total }: { objects: BatchObject[]; total?: number }) {
  const counts: Record<string, number> = {}
  for (const o of objects) counts[o.verdict] = (counts[o.verdict] ?? 0) + 1
  const keys = Object.keys(counts).sort((a, b) => VERDICT_ORDER.indexOf(a) - VERDICT_ORDER.indexOf(b))
  const aiCalled = objects.some(o => rowVerdictSource(o) === 'ai')
  return (
    <div className="text-[11px] text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span>Всего {total ?? objects.length}:</span>
      {keys.map(v => (
        <span key={v} className={VERDICT_STYLE[v] ?? 'text-white'}>{v} {counts[v]}</span>
      ))}
      {!aiCalled && (
        <SumBadge title="Вердикты посчитаны правилами бесплатно. DeepSeek по этим объектам не вызывался — обоснования, уверенности и черновика ответа пока нет">
          ИИ не вызывался
        </SumBadge>
      )}
    </div>
  )
}

/**
 * «Кто с кем не согласен» под таблицей — спокойной строкой, без наведения мыши.
 * Показываем только там, где вердикт переписали ИИ или оператор: у чистых правил
 * сравнивать не с чем.
 */
function ParseDisagreeNote({ objects }: { objects: BatchObject[] }) {
  const rows = objects
    .map(o => ({ plate: o.plate, d: verdictDisagreement(o.verdict, o.heuristic_category, rowVerdictSource(o)) }))
    .filter((r): r is { plate: string | null; d: NonNullable<ReturnType<typeof verdictDisagreement>> } => !!r.d)
  if (rows.length === 0) return null
  return (
    <p className="mt-1.5 text-[10px] leading-4 text-muted">
      ⇄ Расхождение с правилами:{' '}
      {rows.map((r, i) => (
        <span key={`${r.plate}-${i}`}>
          {i > 0 && '; '}
          {r.plate && <b className="font-medium text-secondary">{r.plate}</b>}
          {r.plate && ' — '}правила: {r.d.from} → {r.d.by}: {r.d.to}
        </span>
      ))}.
    </p>
  )
}

/**
 * Пояснения к одиночному разбору: метка «показан сохранённый анализ», ошибка
 * прогона и подозрение на ошибку клиента в гос.номере.
 *
 * Платной кнопки здесь БОЛЬШЕ НЕТ: она одна на карточку и живёт в «Телеметрии»
 * (см. AiAnswerCta) — там же, где появляются её результаты: обоснование,
 * уверенность и черновик. Данные таблицы рисуют SingleParseTable/BatchAnalysis.
 */
function AutoAnalysis({ issueId, issueTitle, companyName }: { issueId: number; issueTitle?: string | null; companyName?: string | null }) {
  // Multi-attachment («общая») issue → single-object analysis is misleading
  // (it picks just the first plate). Defer to «Разбор по объектам» below.
  const { isBatch } = useBatchMode(issueId, issueTitle, companyName)

  // Cached result — show last analysis without re-running the AI (saves tokens).
  const cachedQ = useQuery({
    queryKey: ['automate-cached', issueId],
    queryFn: () => api.getCachedAutomate(issueId),
    enabled: !isBatch,
    staleTime: 5 * 60_000,
  })
  const shown = cachedQ.data?.cached ? (cachedQ.data as unknown as AutomationResult) : null
  const p = shown?.parsed

  // Подозрение на ошибку клиента в гос.номере: не тот формат ИЛИ объект не найден в мониторинге.
  const plateSuspect = !!shown && (!!p?.plate_format_suspect || shown.error === 'object_not_found')

  // У мультиобъектной заявки разбор ведёт BatchAnalysis в том же блоке —
  // одиночный автоанализ взял бы только первый ТС и вводил бы в заблуждение.
  if (isBatch || !shown) return null

  return (
    <div className="space-y-2 text-xs">
      <p className="flex items-center gap-1 text-[10px] text-muted/70">
        <Database size={11} /> показан сохранённый анализ
        {cachedQ.data?.created_at
          ? ` от ${new Date(cachedQ.data.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
          : ''}
      </p>

      {shown.error && (
        <p className="flex items-start gap-1.5 text-warning"><AlertTriangle size={13} className="shrink-0 mt-0.5" /> {shown.reasoning}</p>
      )}

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
    </div>
  )
}

/**
 * ЕДИНСТВЕННАЯ платная кнопка карточки — «✦ Ответ ИИ». Живёт в «Телеметрии»,
 * рядом с местом, где появляются её результаты.
 *
 * Разделение по стоимости (см. память project_free_parse_levels): факты, метрики
 * и предварительный вердикт считаются правилами бесплатно при открытии заявки;
 * обоснование «почему такой вердикт», уверенность и черновик ответа даёт только
 * модель. Один вызов на заявку: для мультиобъектной — `POST /batch/ai`
 * (все объекты за раз), для одиночной — `automate` (он богаче: few-shot,
 * проверка возобновления данных, разбор комментариев).
 */
function AiAnswerCta({ issueId, isBatch, objectCount }: {
  issueId: number
  isBatch: boolean
  objectCount: number
}) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  // Демо-витрина: один вызов модели на заявку, иначе показ превращается в
  // бесплатный DeepSeek. Отметка живёт в localStorage.
  const demoKey = `demo_analyzed_${issueId}`
  const demoUsed = isDemo && !!localStorage.getItem(demoKey)

  const run = useMutation<unknown, unknown, void>({
    mutationFn: () => (isBatch ? api.batchAi(issueId) : api.automateIssue(issueId)),
    onSuccess: () => {
      if (isDemo) localStorage.setItem(demoKey, '1')
      queryClient.invalidateQueries({ queryKey: ['automate-cached', issueId] })
      queryClient.invalidateQueries({ queryKey: ['batch-cached', issueId] })
      queryClient.invalidateQueries({ queryKey: ['parse-free', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      // Трек мог быть закэширован с ошибкой «номер не найден» до анализа (64736, 64965).
      queryClient.invalidateQueries({ queryKey: ['track', issueId] })
    },
  })

  return (
    <div className="rounded-[10px] border-l-2 border-border bg-frame px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-secondary">
        <Sparkles size={12} className="shrink-0" /> Ответ ИИ ещё не запрашивали
      </div>
      <p className="text-[11px] leading-4 text-secondary">
        Метрики, флаги и предварительный вердикт выше посчитаны правилами при открытии
        заявки — это бесплатно. Обоснование «почему такой вердикт», уверенность и
        черновик ответа даёт модель: платный шаг, поэтому только по кнопке.
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] leading-4 text-muted">
          {demoUsed
            ? 'демо-режим: анализ доступен один раз на заявку'
            : isBatch
            ? `${objectCount} ${pluralObjects(objectCount)} за один вызов · платный шаг, отвечает ИИ`
            : 'платный шаг, отвечает ИИ'}
        </span>
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending || demoUsed}
          title={demoUsed
            ? 'Демо: анализ доступен один раз на заявку'
            : 'Отправить разбор в модель — вернёт обоснование, уверенность и черновик ответа. Платный вызов'}
          className={`flex shrink-0 items-center gap-1.5 rounded-pill bg-accent px-4 py-[5px] text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40 ${run.isPending ? 'animate-pulse cursor-wait' : ''} ${demoUsed ? 'cursor-not-allowed' : ''}`}
        >
          {run.isPending ? <Working label="Спрашиваю ИИ…" /> : <><Sparkles size={12} /> Ответ ИИ</>}
        </button>
      </div>
      {run.isPending && (
        <div className="h-1 w-full overflow-hidden rounded-pill bg-base">
          <div className="h-full w-1/4 animate-pulse rounded-pill bg-accent" />
        </div>
      )}
      {run.isError && (
        <p className="text-[11px] text-orange-400">ИИ не ответил. Попробуйте снова.</p>
      )}
    </div>
  )
}

/**
 * Регионы, с которыми работает поддержка (Россети Волга + Урал). Названия нужны,
 * чтобы «регион 63» читалось как «Самара» — по номеру оператор понимает, чей это
 * филиал и к какой бригаде монтажников идти.
 */
const PLATE_REGIONS: Record<string, string> = {
  '02': 'Башкортостан', '12': 'Марий Эл', '13': 'Мордовия', '16': 'Татарстан',
  '18': 'Удмуртия', '21': 'Чувашия', '30': 'Астрахань', '34': 'Волгоград',
  '43': 'Киров', '52': 'Нижний Новгород', '56': 'Оренбург', '58': 'Пенза',
  '59': 'Пермь', '63': 'Самара', '64': 'Саратов', '66': 'Свердловская обл.',
  '73': 'Ульяновск', '74': 'Челябинск', '96': 'Свердловская обл.',
  '116': 'Татарстан', '152': 'Нижний Новгород', '156': 'Оренбург',
  '163': 'Самара', '164': 'Саратов', '173': 'Ульяновск', '196': 'Свердловская обл.',
}

/**
 * Регион по коду в конце гос.номера. Отдельного поля в системе нет — код региона
 * и есть источник (тот же приём, что в правилах просроченных заявок).
 * Возвращает «63 (Самара)» либо «63», если название неизвестно; null — если в
 * номере кода региона нет.
 */
function plateRegion(plate: string | null | undefined): string | null {
  if (!plate) return null
  const m = /(\d{2,3})$/.exec(plate.replace(/\s/g, ''))
  if (!m) return null
  const code = m[1]
  const name = PLATE_REGIONS[code]
  return name ? `${code} (${name})` : code
}

/** «1 объект / 3 объекта / 6 объектов» — падеж считаем, а не подставляем. */
function pluralObjects(n: number): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return 'объектов'
  if (mod10 === 1) return 'объект'
  if (mod10 >= 2 && mod10 <= 4) return 'объекта'
  return 'объектов'
}

/**
 * Заголовки таблицы разбора (v4). Короткие подписи — иначе 8 колонок не влезают
 * в рельсу 680px; полная расшифровка уезжает в нативный тултип. Один источник для
 * одиночной и пакетной таблиц, чтобы шапки не расходились.
 */
const PARSE_COLUMNS: { label: string; title: string }[] = [
  { label: 'Номер', title: 'Гос.номер' },
  { label: 'Дата', title: 'Дата неисправности' },
  { label: 'ПЛ', title: 'Пробег по путевому листу, км' },
  { label: 'ГЛОНАСС', title: 'ГЛОНАСС заявл. — заявленный пробег по системе, км' },
  { label: 'Факт', title: 'По факту — пробег по треку, км' },
  { label: 'Вердикт', title: 'Вердикт ИИ — можно изменить' },
]

/** actions — сколько служебных колонок без подписи идёт справа (трек, дочерняя). */
function ParseTableHead({ actions }: { actions: number }) {
  return (
    <thead className="text-muted">
      <tr className="text-left">
        {PARSE_COLUMNS.map(c => (
          <th key={c.label} title={c.title} className="font-medium py-1 pr-2 whitespace-nowrap">
            {c.label}
          </th>
        ))}
        {Array.from({ length: actions }, (_, i) => <th key={`act-${i}`} className="pr-1" />)}
      </tr>
    </thead>
  )
}

/** Пояснение к таблице разбора — что такое строка и что даёт клик по ней. */
function ParseTableNote() {
  return (
    <p className="mt-1.5 text-[10px] leading-4 text-muted">
      Строка — объект. Клик по строке выбирает объект, ниже показывается его телеметрия.
    </p>
  )
}

/** Полный ИИ-прогон → строка таблицы разбора того же формата, что у пакетной. */
function rowFromAutomate(res: AutomationResult): BatchObject {
  const t = res.telemetry
  return {
    file: '', plate: res.parsed?.plate ?? null, date: res.parsed?.date ?? null,
    sheet_mileage_km: res.parsed?.sheet_mileage_km ?? null,
    declared_system_km: res.parsed?.declared_system_km ?? null,
    system_mileage_km: t?.system_mileage_km ?? null,
    flags: t?.flags ?? [], teleport_jumps: t?.teleport_jumps ?? 0,
    telemetry: t ?? null,
    verdict: res.category,
    spec_vehicle: res.spec_vehicle,
    // `automate` без DeepSeek не бывает — у кэшей без поля источник всё равно ИИ.
    verdict_source: res.verdict_source ?? 'ai',
    heuristic_category: res.heuristic_category ?? null,
    // Результаты платного прогона едут в строке — блок телеметрии читает их
    // оттуда же, что и у пакетной заявки, и не знает, откуда пришёл разбор.
    confidence: res.confidence ?? null,
    reasoning: res.reasoning ?? null,
    draft_answer: res.draft_answer ?? null,
  }
}

/**
 * Разбор одиночной заявки — та же таблица, что и у пакетной, но из одной строки.
 * Оператор видит разбор одинаково независимо от того, один в заявке объект или
 * двадцать.
 *
 * Приоритет данных: кэш `automate` (богаче — уверенность, обоснование, черновик)
 * выше бесплатного разбора фактов `parse`. `parse` — то, что показываем, ПОКА ИИ
 * не звали: он и наполняет таблицу при открытии карточки (GET кэша, при промахе —
 * POST без вложений, ноль токенов). Мультиобъектную заявку ведёт BatchAnalysis.
 */
function SingleParseTable({ issueId, issueTitle, companyName, onSelect }: {
  issueId: number
  issueTitle?: string | null
  companyName?: string | null
  onSelect?: (obj: BatchObject) => void
}) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  // Какое поле сейчас правится / сохраняется. Правка только по клику на карандаш —
  // защита от случайного изменения. cancelEditRef — отмена по Escape (blur без применения).
  const [editingField, setEditingField] = useState<'plate' | 'date' | null>(null)
  const [savingField, setSavingField] = useState<'plate' | 'date' | null>(null)
  const cancelEditRef = useRef(false)

  const { isBatch, ready, cachedBatchObjects } = useBatchMode(issueId, issueTitle, companyName)

  const automateQ = useQuery({
    queryKey: ['automate-cached', issueId],
    queryFn: () => api.getCachedAutomate(issueId),
    staleTime: 5 * 60_000,
  })
  const automate = automateQ.data?.cached ? (automateQ.data as unknown as AutomationResult) : null

  // Бесплатный разбор зовём только там, где он реально нужен: заявка одиночная,
  // режим уже известен, а полного ИИ-прогона в кэше нет (он богаче и главнее).
  const freeQ = useFreeParse(issueId, ready && !isBatch && automateQ.isSuccess && !automate)
  const free = freeQ.data

  // Строка таблицы: сначала ИИ-прогон, иначе единственная строка бесплатного
  // разбора. Две и более строк — территория пакетной таблицы, не наша.
  const row: BatchObject | null = automate
    ? rowFromAutomate(automate)
    : (free?.objects?.length === 1 ? free.objects[0] : null)
  const p = row

  // Уточнение номера/даты = перепроверка ТС в гео по исправленным данным. Пока ИИ
  // не звали, правка идёт бесплатным `parse` — незачем платить за опечатку клиента.
  const refine = useMutation<AutomationResult | ParseResult, unknown, { plate?: string; date?: string }>({
    mutationFn: (override) =>
      automate ? api.automateIssue(issueId, override) : api.parseIssue(issueId, override),
    onSettled: () => setSavingField(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automate-cached', issueId] })
      queryClient.invalidateQueries({ queryKey: ['parse-free', issueId] })
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

  // Строку отдаём наверх, чтобы блок телеметрии показывал этот же объект
  // (вместе с источником вердикта — от него зависит вид пилюли и полоса доверия).
  useEffect(() => {
    if (!row || !onSelect) return
    // Таблицу ведёт пакетный разбор — тогда и объект выбирает он, иначе телеметрия
    // показала бы строку, которой на экране нет.
    if (isBatch || cachedBatchObjects >= 1) return
    onSelect(row)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automate, free, isBatch, cachedBatchObjects])

  // Пакетная заявка (в т.ч. когда пакетный разбор уже дал строки) рисует таблицу
  // сама — двух таблиц об одном и том же в карточке быть не должно.
  if (isBatch || cachedBatchObjects >= 1) return null

  if (!row) {
    // Разбор состоялся, но номер не нашёлся — объясняем причину вместо пустоты.
    if (free?.note) return <p className="text-[11px] leading-4 text-muted">{free.note}</p>
    if (freeQ.isFetching) {
      return (
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <Loader2 size={12} className="animate-spin shrink-0" /> Разбираю факты заявки…
        </p>
      )
    }
    return null
  }

  const t = row.telemetry

  return (
    <>
    <ParseSummary objects={[row]} total={1} />
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <ParseTableHead actions={1} />
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
            <td className="pr-2">{row.sheet_mileage_km ?? '—'}</td>
            <td className="pr-2">{row.declared_system_km ?? '—'}</td>
            <td className="pr-2 text-white font-medium">{row.system_mileage_km ?? t?.system_mileage_km ?? '—'}</td>
            <td className="pr-2">
              <VerdictPill verdict={row.verdict} source={row.verdict_source} />
              {row.spec_vehicle && (
                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-pill bg-warning/15 text-warning text-[9px] font-medium align-middle">
                  спецтехника
                </span>
              )}
            </td>
            <td className="text-center">
              <TrackLink plate={row.plate ?? null} date={row.date ?? null} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ParseDisagreeNote objects={[row]} />
    <ParseTableNote />
    </>
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

// Цвет вердикта живёт рядом с пилюлей (TelemetryPanel) — один источник для
// таблицы разбора и блока телеметрии, иначе они расходятся по оттенкам.
const VERDICT_STYLE = VERDICT_TEXT_STYLE


/**
 * Чип «✦ черновик ИИ для {госномер}» в липком баре (v4). Та же логика, что была
 * у кнопки «Составить ответ» блока «③ Ответ»: с вложениями — ответ по таблице
 * разбора, без вложений — по одиночному автоанализу.
 */
function DraftChip({ issueId, hasExtractable, plate, draft, onUseDraft }: {
  issueId: number
  hasExtractable: boolean
  plate?: string | null
  /** Готовый черновик выбранной строки — вставляем БЕЗ запроса и без токенов. */
  draft?: string | null
  onUseDraft: (text: string) => void
}) {
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
  // Черновик уже есть (прогон ИИ по объектам) — чип просто переносит его в поле
  // ответа. Раньше он всегда стрелял платным запросом, даже когда текст был готов.
  if (draft) {
    return (
      <button
        onClick={() => onUseDraft(draft)}
        title="Вставить черновик, подготовленный ИИ для выбранного объекта"
        className="flex shrink-0 items-center gap-1 rounded-pill border border-accent bg-accent/15 px-2.5 py-[3px] text-[11px] font-medium text-accent transition-colors hover:bg-accent hover:text-black"
      >
        <Sparkles size={11} /> черновик ИИ{plate ? ` для ${plate}` : ''}
      </button>
    )
  }
  return (
    <>
      <button
        onClick={() => composeMut.mutate()}
        disabled={composeMut.isPending || isDemo}
        title={isDemo ? 'Недоступно в демо-режиме'
          : 'Составить черновик ответа — платный вызов ИИ (быстрее получить его вместе с разбором кнопкой «Ответ ИИ» в «Телеметрии»)'}
        className={`flex shrink-0 items-center gap-1 rounded-pill border border-accent bg-accent/15 px-2.5 py-[3px] text-[11px] font-medium text-accent hover:bg-accent hover:text-black transition-colors disabled:opacity-40 ${composeMut.isPending ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
      >
        {composeMut.isPending
          ? <Working label="Составляю…" />
          : <><Sparkles size={11} /> составить черновик{plate ? ` для ${plate}` : ''}</>}
      </button>
      {composeMut.isError && <p className="text-[11px] text-orange-400">Ошибка составления ответа. Попробуйте снова.</p>}
    </>
  )
}

function BatchAnalysis({ issueId, issueTitle, issueDescription, onOpenExternal, selectedIdx, onSelectObject, onParse, onUseDraft }: {
  issueId: number
  issueTitle?: string | null
  issueDescription?: string | null
  companyName?: string | null
  onOpenExternal: (extId: number) => void
  /** Индекс строки, чью телеметрию показывает блок «② Телеметрия и вердикт». */
  selectedIdx?: number | null
  onSelectObject?: (idx: number, objects: import('../types').BatchObject[]) => void
  /**
   * Строки разбора наружу: карточке нужно знать их число (один вызов ИИ на все
   * объекты) и звали ли ИИ — от этого зависит платная кнопка в «Телеметрии».
   */
  onParse?: (objects: import('../types').BatchObject[], aiNote?: string | null) => void
  /** Вставить готовый текст в поле ответа липкого бара (сводный ответ по ОДКР). */
  onUseDraft?: (text: string) => void
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
  // Какая строка правит дату (симметрично номеру — по клику на карандаш).
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null)
  const cancelDateRef = useRef(false)
  const [dateLoading, setDateLoading] = useState<Set<string>>(new Set())
  const [dateError, setDateError] = useState<string | null>(null)
  // Разбор пересчитан в этой сессии (а не показан из кэша) — только для подписи.
  // Сами данные всегда берём из кэша react-query: источник один, иначе результат
  // прогона ИИ (он пишет в тот же кэш) не попадал бы в таблицу.
  const [freshRun, setFreshRun] = useState(false)
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
    setFreshRun(false)
    setVerdictError(null)
    setPlateError(null)
    setDateError(null)
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

  /** Разбор — один источник правды: кэш запроса. Все правки пишут сюда же. */
  const putBatch = (data: BatchResult) => {
    queryClient.setQueryData(['batch-cached', issueId], { cached: true, ...data })
  }

  // Строки разбора наружу: карточке нужно их число (один вызов ИИ на все объекты)
  // и звали ли ИИ — от этого зависит платная кнопка в «Телеметрии». Эффект стоит
  // ДО любых ранних выходов: хуки не могут вызываться условно.
  const reportRows = cached?.objects ?? null
  const reportNote = cached?.ai_note ?? null
  useEffect(() => {
    if (reportRows) onParse?.(reportRows, reportNote)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportRows, reportNote])

  const run = useMutation({
    mutationFn: () => api.automateBatch(issueId),
    onSuccess: (data) => {
      setVerdictError(null)
      setFreshRun(true)
      putBatch(data)
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
  // Сводный ответ по агрегатной (ОДКР) заявке: группировка по вердиктам делается
  // детерминированно в коде, LLM только формулирует (см. compose_aggregate_answer).
  const aggregate = useMutation({
    mutationFn: () => api.composeAnswer(issueId),
    onSuccess: (data) => { if (data.answer) onUseDraft?.(data.answer) },
  })

  const startRun = () => {
    cancelOcrLoop()
    ocrRoundsRef.current = 0
    lastPagesRef.current = -1
    setAutoOcr(true)
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
      putBatch(updated)
    } catch {
      setPlateError(`Не удалось обновить номер на ${np} — проверьте, найден ли он в гео.`)
    } finally {
      setPlateLoading(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Ручная правка ДАТЫ неисправности: клиент так же часто путает дату (в т.ч.
  // опечатка года), как и номер. Бэкенд пересчитывает телеметрию и вердикт этой
  // строки за новую дату — раньше дату в пакетном разборе править было нельзя.
  const handleDateChange = async (o: import('../types').BatchObject, raw: string, idx: number) => {
    const nd = raw.trim()
    if (!nd || nd === (o.date ?? '')) return
    const key = rowKey(o, idx)
    setDateLoading(prev => new Set([...prev, key]))
    setDateError(null)
    try {
      const updated = await api.updateBatchDate(issueId, nd, o.plate, o.date, o.file || undefined, idx)
      putBatch(updated)
    } catch {
      setDateError(`Не удалось обновить дату на ${nd} — проверьте данные ТС в гео.`)
    } finally {
      setDateLoading(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Кнопка «Разбор по объектам» доступна для любой заявки с >=1 извлекаемым вложением —
  // оператор может вручную запустить разбор (напр. 63317: 1 файл, ~40 ТС). Авто-запуск
  // OCR не делаем; таблица рисуется из результата run/кеша (>=2 объекта → мультиобъект).
  if (extractable.length < 1 && !multiInText) return null

  const res = cached as BatchResult | null
  const isCached = !!cached && !freshRun
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
      putBatch(updated)
    } catch {
      setVerdictError(`Не удалось сохранить вердикт для ${o.plate}`)
    } finally {
      setVerdictLoading(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Разбор уже есть → иконочная кнопка «обновить» справа. Первичный запуск и
  // «продолжить распознавание» остаются текстовыми: без подписи их смысл теряется.
  const compact = !!res && !ocrPending
  // Первичный запуск: подписываем, сколько файлов предстоит распознать, и зачем
  // это нужно — пакетный разбор сам не стартует (OCR + токены DeepSeek дорогие).
  const attachCount = extractable.length
  const startLabel = attachCount > 0
    ? `Разобрать ${attachCount} ${pluralAttachments(attachCount)}`
    : 'Разобрать заявку по объектам'

  return (
    <div className="space-y-2">
      {!res && !ocrBusy && (
        <p className="text-[11px] leading-4 text-secondary">
          {attachCount > 0
            ? `В заявке ${attachCount} ${pluralAttachments(attachCount)} и несколько единиц техники — ИИ распознает файлы и сопоставит объекты с гео.`
            : 'В заявке несколько единиц техники — ИИ разберёт текст письма и сопоставит объекты с гео.'}
        </p>
      )}
      <div className={compact ? 'flex justify-end' : ''}>
        <button
          onClick={startRun}
          disabled={ocrBusy || isDemo}
          title={isDemo ? 'Недоступно в демо-режиме'
            : compact ? 'Обновить разбор'
            : attachCount > 0 ? `Распознать ${attachCount} ${pluralAttachments(attachCount)} (OCR) и сопоставить с объектами в гео`
            : undefined}
          className={`flex items-center justify-center gap-2 bg-frame border border-info/40 text-info hover:bg-info/10 text-xs font-semibold rounded-md transition-colors disabled:opacity-40 ${compact ? (ocrBusy ? 'px-2.5 py-1.5' : 'p-1.5') : 'w-full py-2'} ${ocrBusy ? 'animate-pulse cursor-wait' : ''} ${isDemo ? 'cursor-not-allowed' : ''}`}
        >
          {ocrBusy ? (
            <Working label={compact ? 'Распознаю…' : 'Распознаю вложения…'} />
          ) : ocrPending ? (
            <><RefreshCw size={14} /> Продолжить распознавание</>
          ) : res ? (
            <RefreshCw size={15} />
          ) : (
            <><Layers size={14} /> {startLabel}</>
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
          <ParseSummary objects={res.objects} total={res.total} />
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <ParseTableHead actions={2} />
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
                          ? 'bg-accent/10 border-l-2 border-l-accent'
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
                      <td className="pr-2">
                        {isDemo || !o.plate ? (o.date ?? '—') : editingDateKey === key ? (
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="date"
                              autoFocus
                              defaultValue={o.date ?? ''}
                              disabled={dateLoading.has(key)}
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                else if (e.key === 'Escape') { cancelDateRef.current = true; (e.target as HTMLInputElement).blur() }
                              }}
                              onBlur={e => {
                                const val = e.target.value
                                setEditingDateKey(null)
                                if (cancelDateRef.current) { cancelDateRef.current = false; return }
                                handleDateChange(o, val, idx)
                              }}
                              className="w-[8.5rem] rounded border border-accent bg-frame px-1 py-0.5 text-[11px] text-white outline-none disabled:opacity-50"
                            />
                            <span className="shrink-0 text-[9px] text-muted/60">Enter / Esc</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <span className={o.date ? '' : 'text-warning'}>{o.date ?? 'нет даты'}</span>
                            <button
                              onClick={e => { e.stopPropagation(); setEditingDateKey(key) }}
                              title="Изменить дату неисправности и перепроверить в гео"
                              className="shrink-0 text-muted/40 hover:text-accent transition-colors"
                            ><Pencil size={11} /></button>
                            {o.date_edited && <span title="Дата изменена оператором, перепроверено в гео" className="shrink-0 text-info">●</span>}
                            {dateLoading.has(key) && <span className="shrink-0 animate-spin text-muted">↻</span>}
                          </span>
                        )}
                      </td>
                      <td className="pr-2">{o.sheet_mileage_km ?? '—'}</td>
                      <td className="pr-2">{o.declared_system_km ?? '—'}</td>
                      <td className="pr-2">{o.system_mileage_km ?? '—'}</td>
                      <td className="pr-2">
                        {isDemo ? (
                          <VerdictPill verdict={o.verdict} source={rowVerdictSource(o)} />
                        ) : (
                          <span className="inline-flex min-w-0 items-center">
                            {/* Пилюля показывает ИСТОЧНИК вердикта (правила / ИИ / оператор),
                                а нативный select лежит прозрачным слоем поверх — так остаётся
                                штатный выпадающий список без своей вёрстки. */}
                            <span className="relative inline-flex min-w-0 items-center rounded-pill focus-within:ring-1 focus-within:ring-accent">
                              <VerdictPill
                                verdict={o.verdict}
                                source={rowVerdictSource(o)}
                                className={isVerdictLoading ? 'opacity-50' : ''}
                                title={verdictCellHint(o)}
                              />
                              <span className="ml-1.5 shrink-0 text-[11px] text-muted">▾</span>
                              <select
                                value={o.verdict}
                                disabled={isVerdictLoading}
                                onChange={e => handleVerdictChange(o, e.target.value, idx)}
                                title={verdictCellHint(o)}
                                aria-label="Вердикт по объекту"
                                className="absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent text-transparent opacity-0 outline-none disabled:cursor-wait"
                              >
                                {ALLOWED_VERDICTS.map(v => (
                                  <option key={v} value={v} className="bg-card text-primary">{v}</option>
                                ))}
                                {!ALLOWED_VERDICTS.includes(o.verdict as typeof ALLOWED_VERDICTS[number]) && (
                                  <option value={o.verdict} className="bg-card text-primary">{o.verdict}</option>
                                )}
                              </select>
                            </span>
                            {(() => {
                              const d = verdictDisagreement(o.verdict, o.heuristic_category, rowVerdictSource(o))
                              return d ? (
                                <span
                                  title={`Правила: ${d.from} → ${d.by}: ${d.to}`}
                                  className="ml-1.5 shrink-0 text-[11px] text-muted"
                                >⇄</span>
                              ) : null
                            })()}
                            {isVerdictLoading && (
                              <span className="ml-1.5 animate-spin text-muted shrink-0">↻</span>
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
          <ParseDisagreeNote objects={res.objects} />
          <ParseTableNote />
          {isAggregate && (
            <div className="space-y-1.5">
              <p className="flex items-start gap-1.5 text-[11px] text-muted leading-relaxed">
                <Info size={13} className="shrink-0 mt-0.5 text-info" />
                <span>Агрегатная заявка (ОДКР) — отвечаем одним ответом по всем объектам, без разбивки на дочерние.</span>
              </p>
              {/* Сводный ответ живёт здесь, а не в чипе бара: он про ВСЮ заявку,
                  а чип подставляет черновик выбранного объекта. */}
              <button
                onClick={() => aggregate.mutate()}
                disabled={aggregate.isPending || isDemo}
                title={isDemo ? 'Недоступно в демо-режиме'
                  : 'Собрать ОДИН ответ по всем объектам заявки и вставить в поле ответа — платный вызов ИИ'}
                className={`flex items-center gap-1.5 rounded-pill border border-accent bg-accent/15 px-3 py-[5px] text-[11px] font-medium text-accent transition-colors hover:bg-accent hover:text-black disabled:opacity-40 ${aggregate.isPending ? 'animate-pulse cursor-wait' : ''}`}
              >
                {aggregate.isPending
                  ? <Working label="Собираю сводный ответ…" />
                  : <><Sparkles size={11} /> Один ответ по всем объектам</>}
              </button>
              {aggregate.isError && (
                <p className="text-[11px] text-orange-400">Не удалось собрать сводный ответ. Попробуйте снова.</p>
              )}
            </div>
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
      {dateError && <p className="text-xs text-orange-400">{dateError}</p>}
    </div>
  )
}

/** Цветной квадрат типа файла (макет .fi-*): по нему тип виден без чтения имени. */
const KIND_TILE: Record<string, { bg: string; label: string }> = {
  word: { bg: '#2B579A', label: 'W' },
  excel: { bg: '#217346', label: 'X' },
  pdf: { bg: '#C1341A', label: 'P' },
  image: { bg: '#5B5BD6', label: 'IMG' },
  text: { bg: '#3F3F46', label: 'TXT' },
  other: { bg: '#3F3F46', label: '?' },
}

function formatSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

/**
 * Статус распознавания ОДНОГО файла (поле `ocr` из `GET /attachments`).
 * Раньше фронт писал «ИИ читает» у всякого извлекаемого файла — в том числе у
 * большого PDF, прочитанного на 4 страницы из 6. Теперь состояние честное.
 */
function ocrLabel(a: IssueAttachment): { text: string; warn: boolean; hint: string } {
  const st = a.ocr?.status
  const pages = a.ocr?.pages_done ?? 0
  if (st === 'done') {
    return { text: '✓ распознан', warn: false, hint: 'Текст извлечён полностью — ИИ его прочитал' }
  }
  if (st === 'partial') {
    return {
      text: pages > 0 ? `прочитано ${pages} стр.` : 'частично',
      warn: true,
      hint: 'Большой документ распознаётся порциями — нажмите «Продолжить распознавание» в блоке «Разбор»',
    }
  }
  if (st === 'unavailable') {
    return {
      text: a.kind === 'image' ? 'скан, OCR недоступен' : 'текст не извлекается',
      warn: true,
      hint: 'Растровый скан без текстового слоя — ИИ пропускает его и говорит об этом в разборе',
    }
  }
  // queued либо старый бэкенд без поля ocr — не выдумываем «распознан».
  return {
    text: a.extractable ? 'в очереди' : 'текст не извлекается',
    warn: false,
    hint: a.extractable
      ? 'Ещё не читался — распознавание запускается кнопкой в блоке «Разбор»'
      : 'Формат без текстового слоя — ИИ его не читает',
  }
}

const ATTACH_PREVIEW = 12

function AttachmentsSection({ issueId }: { issueId: number }) {
  const { data: items = [] } = useQuery({
    queryKey: ['attachments', issueId],
    queryFn: () => api.listAttachments(issueId),
    staleTime: 5 * 60_000,
  })
  const [expanded, setExpanded] = useState(false)

  if (items.length === 0) return null

  // Агрегатный прогресс OCR живёт ЗДЕСЬ, рядом с файлами: раньше он был только в
  // «Разборе», и оператор не понимал, какие именно вложения ИИ уже прочитал.
  // Действие («Продолжить распознавание») остаётся в «Разборе» — две кнопки на
  // одну операцию хуже, чем одна подпись, куда идти.
  const readable = items.filter(a => a.extractable)
  const readDone = readable.filter(a => a.ocr?.status === 'done').length
  const pagesDone = items.reduce((sum, a) => sum + (a.ocr?.pages_done ?? 0), 0)
  const scans = items.filter(a => a.ocr?.status === 'unavailable').length
  const partial = readable.filter(a => a.ocr?.status === 'partial').length
  const percent = readable.length > 0 ? Math.round((readDone / readable.length) * 100) : 0
  const shown = expanded ? items : items.slice(0, ATTACH_PREVIEW)

  // Свёрнуто по умолчанию: список файлов оттесняет вниз более важный контекст
  // заявки. Раскрытие — кликом по заголовку секции, состояние помнит localStorage.
  return (
    <Block title="Вложения" count={items.length} defaultOpen={false} storageKey="attachments">
      {readable.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] leading-4 text-secondary">
              ИИ прочитал <b className="font-medium text-white">{readDone} из {readable.length}</b> файлов
            </span>
            {pagesDone > 0 && (
              <SumBadge title="Распознано страниц во всех вложениях">страниц {pagesDone}</SumBadge>
            )}
            {scans > 0 && (
              <SumBadge title="Растровые сканы без текстового слоя — OCR их не берёт">скан {scans}</SumBadge>
            )}
          </div>
          <div
            title={`Прогресс распознавания вложений: ${readDone} из ${readable.length}`}
            className="h-1 w-full overflow-hidden rounded-pill bg-frame"
          >
            <div className="h-full rounded-pill bg-accent" style={{ width: `${percent}%` }} />
          </div>
          {(partial > 0 || readDone < readable.length) && (
            <p className="text-[10px] leading-4 text-muted">
              Большие документы читаются порциями, чтобы не блокировать сервис. Дочитать остаток —
              кнопка «Продолжить распознавание» в блоке «Разбор».
            </p>
          )}
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(74px,1fr))] gap-1.5">
        {shown.map(a => {
          const url = api.attachmentUrl(issueId, a.id)
          const tile = KIND_TILE[a.kind] ?? KIND_TILE.other
          const ocr = ocrLabel(a)
          return (
            <a
              key={a.id}
              href={url}
              target="_blank"
              rel="noreferrer"
              title={`${a.name ?? `#${a.id}`} — открыть / скачать. ${ocr.hint}`}
              className="min-w-0 rounded-[10px] border border-line bg-frame px-1.5 pb-[7px] pt-2.5 text-center hover:border-accent transition-colors"
            >
              <span
                style={{ background: tile.bg }}
                className="mx-auto mb-1.5 flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-[9px] font-bold leading-none text-white"
              >
                {tile.label}
              </span>
              <span className="block truncate text-[10px] leading-[14px] text-muted">{a.name ?? `#${a.id}`}</span>
              <span className="block text-[9px] leading-3 text-muted/60">{formatSize(a.size)}</span>
              <span className={`block truncate text-[9px] leading-3 ${ocr.warn ? 'text-warning' : 'text-muted'}`}>
                {ocr.text}
              </span>
            </a>
          )
        })}
      </div>
      {items.length > ATTACH_PREVIEW && (
        <button
          onClick={() => setExpanded(v => !v)}
          title={expanded ? 'Показать только первые файлы' : `Показать все ${items.length} вложений`}
          className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
        >
          {expanded ? 'Свернуть список' : `Показать все ${items.length}`}
          <ChevronDown size={12} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
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
/** «1 вложение / 2 вложения / 5 вложений» — для подписи кнопки разбора. */
function pluralAttachments(n: number): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return 'вложений'
  if (mod10 === 1) return 'вложение'
  if (mod10 >= 2 && mod10 <= 4) return 'вложения'
  return 'вложений'
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
/** Кнопка-вариант (макет .opt): выбор одного значения из набора пилюлей. */
function OptPill({ on, onClick, title, children }: {
  on: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`shrink-0 rounded-pill border px-[11px] py-1 text-[11px] font-medium leading-4 transition-colors ${
        on ? 'border-accent bg-accent/15 text-accent' : 'border-border bg-frame text-secondary hover:border-muted hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

/** Вердикты, которые оператор может назвать «правильной категорией» в оценке. */
const FEEDBACK_CATEGORIES = [
  'Глушение', 'Данные верны', 'Не было питания', 'Нет данных',
  'Терминал подключился', 'Проверить',
]

function AiFeedbackPanel({ issueId, aiAnswered, objectCount }: {
  issueId: number
  /** ИИ по заявке отвечал — иначе оценивать нечего: вердикт посчитан правилами. */
  aiAnswered: boolean
  objectCount: number
}) {
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

      {/* Вопрос + оценка в одну строку: без вопроса иконки 👍/👎 висели без
          повода. Пока ИИ не звали, оценивать нечего — вердикт посчитан правилами. */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-[11px] leading-4 text-secondary">
          {aiAnswered
            ? `ИИ разобрал ${objectCount} ${pluralObjects(objectCount)} — разбор верный?`
            : 'ИИ ещё не вызывали — оценивать нечего: вердикт посчитан правилами'}
        </span>
        {aiAnswered && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={saveGood}
              disabled={submit.isPending || isDemo}
              title={isDemo ? 'Недоступно в демо-режиме' : 'Разобрано верно — заявка уйдёт в тренировочные образцы как удачный пример'}
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
              title={isDemo ? 'Недоступно в демо-режиме' : 'Ошибка разбора — указать, что именно ИИ понял неправильно'}
              className={`flex items-center justify-center p-1.5 rounded-md border transition-colors disabled:opacity-40 ${
                feedback?.rating === 'bad' || showBadForm
                  ? 'border-orange-500/60 bg-orange-500/10 text-orange-400'
                  : 'border-border text-muted hover:text-orange-400 hover:border-orange-500/50'
              } ${isDemo ? 'cursor-not-allowed' : ''}`}
            >
              <ThumbsDown size={15} />
            </button>
          </div>
        )}
      </div>

      {/* Форма «ошибка разбора» */}
      {showBadForm && !isDemo && (
        <div className="border border-line rounded-md px-3 py-2.5 space-y-2">
          {/* Пилюли вместо выпадающих списков: вариантов мало, они видны сразу, а
              выбор — один клик (в макете это .opt). */}
          <div>
            <span className="mb-1 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">Тип ошибки</span>
            <div className="flex flex-wrap gap-1.5">
              {AI_ERROR_KINDS.map(k => (
                <OptPill
                  key={k.value}
                  on={errorKind === k.value}
                  onClick={() => setErrorKind(k.value)}
                  title={`${k.value} — ${k.label.toLowerCase()}`}
                >
                  {k.label}
                </OptPill>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">Комментарий</span>
            <textarea
              value={fbComment}
              onChange={e => setFbComment(e.target.value)}
              rows={2}
              placeholder="Что именно не так…"
              title="Свободный комментарий — попадёт в раздел «Оценки ИИ» и в дообучение"
              className="w-full resize-none rounded-xl border border-border bg-frame px-2.5 py-1.5 text-xs leading-relaxed outline-none focus:border-accent"
            />
          </div>
          <div>
            <span className="mb-1 block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">
              Правильная категория (необязательно)
            </span>
            <div className="flex flex-wrap gap-1.5">
              {FEEDBACK_CATEGORIES.map(c => (
                <OptPill
                  key={c}
                  on={correctCategory === c}
                  onClick={() => setCorrectCategory(prev => (prev === c ? '' : c))}
                  title={`Вердикт «${c}»`}
                >
                  {c}
                </OptPill>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] leading-4 text-muted">Оценка видна в разделе «Оценки ИИ» и идёт в few-shot</span>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => setShowBadForm(false)}
                title="Отменить оценку"
                className="rounded-pill border border-border bg-frame px-3 py-[5px] text-xs font-medium text-secondary hover:border-muted hover:text-white transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={saveBad}
                disabled={submit.isPending}
                title="Сохранить оценку разбора"
                className={`flex items-center gap-1.5 rounded-pill bg-accent px-3 py-[5px] text-xs font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50 ${submit.isPending ? 'animate-pulse cursor-wait' : ''}`}
              >
                {submit.isPending ? <Working label="Сохраняю…" /> : <><Check size={13} /> Сохранить</>}
              </button>
            </div>
          </div>
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
  // Строки текущего разбора (1 или N) и пояснение прогона ИИ: от них зависит
  // платная кнопка в «Телеметрии» — один вызов модели на ВСЕ объекты заявки.
  const [parseRows, setParseRows] = useState<BatchObject[]>([])
  const [batchAiNote, setBatchAiNote] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<typeof ALL_STATUSES[number] | null>(null)
  const [resolveNotice, setResolveNotice] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Липкий бар v4: единственная точка составления ответа. Раскрывается по фокусу
  // на поле — тогда появляется второй ряд (черновик ИИ, публичный/приватный, «Ещё»).
  const [barExpanded, setBarExpanded] = useState(false)
  // Галочки «скопировано» в шапке (номер заявки и телефон контакта).
  const [numCopied, setNumCopied] = useState(false)
  const [phoneCopied, setPhoneCopied] = useState(false)
  // Секция, с которой оператор работает прямо сейчас: только она носит лаймовую
  // полосу и акцентный заголовок. Раскрыто при этом может быть сколько угодно.
  const [activeSection, setActiveSection] = useState<string | null>(null)
  // Как только оператор сам выбрал секцию — дефолт («Разбор») больше не
  // навязываем: иначе догрузка вложений/связанных дёрнула бы полосу из-под рук.
  const sectionPickedRef = useRef(false)
  const activeSectionValue = useMemo(() => ({
    active: activeSection,
    activate: (id: string) => { sectionPickedRef.current = true; setActiveSection(id) },
    clear: (id: string) => {
      sectionPickedRef.current = true
      setActiveSection(prev => (prev === id ? null : prev))
    },
  }), [activeSection])

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
    setBarExpanded(false)
    setParseRows([])
    setBatchAiNote(null)
    // Новая заявка — активную секцию считаем заново (см. эффект ниже); сама
    // раскрытость секций при этом сохраняется, она живёт в localStorage.
    sectionPickedRef.current = false
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
  // Лента по умолчанию показывает ХВОСТ переписки: одного последнего комментария
  // не хватало, чтобы понять контекст (вопрос клиента → ответ → уточнение), а вся
  // лента у долгих заявок уводит остальные секции далеко вниз.
  const [allComments, setAllComments] = useState(false)
  const COMMENTS_PREVIEW = 4
  const visibleComments = allComments ? comments : comments.slice(-COMMENTS_PREVIEW)

  // Кол-во извлекаемых вложений для управления видимостью AutoAnalysis
  const { data: issueAttachments = [] } = useQuery({
    queryKey: ['attachments', selectedIssueId],
    queryFn: () => api.listAttachments(selectedIssueId!),
    enabled: selectedIssueId != null,
    staleTime: 5 * 60_000,
  })
  const extractableCount = issueAttachments.filter((a: import('../types').IssueAttachment) => a.extractable).length

  // Оценка разбора — в счётчик секции, чтобы видеть её не разворачивая блок.
  const { data: fbSummary } = useQuery({
    queryKey: ['ai-feedback', selectedIssueId],
    queryFn: () => api.getAiFeedback(selectedIssueId!),
    enabled: selectedIssueId != null,
    staleTime: 30_000,
  })
  const feedbackLabel = fbSummary?.feedback
    ? (fbSummary.feedback.rating === 'good' ? 'верно' : 'с ошибкой')
    : 'не оценён'

  // Тот же ключ, что у AutoAnalysis: подписываемся на кэш анализа, чтобы блок
  // телеметрии знал уверенность и «можно авто» без подъёма состояния наверх.
  const { data: automateCached } = useQuery({
    queryKey: ['automate-cached', selectedIssueId],
    queryFn: () => api.getCachedAutomate(selectedIssueId!),
    enabled: selectedIssueId != null,
    staleTime: 5 * 60_000,
  })

  // Дефолтная подсветка: «Разбор», иначе первая раскрытая секция. Пересчитываем
  // и при догрузке условных секций («Вложения», «Связанные») — до тех пор, пока
  // оператор не выбрал секцию сам.
  const hasAttachments = issueAttachments.length > 0
  const relatedDetail = data?.okdesk_detail
  const hasRelated = !!relatedDetail && (relatedDetail.parent_id != null || relatedDetail.child_ids.length > 0)
  useEffect(() => {
    if (sectionPickedRef.current) return
    setActiveSection(initialActiveSection({ attachments: hasAttachments, related: hasRelated }))
  }, [selectedIssueId, hasAttachments, hasRelated])

  const addComment = useMutation({
    mutationFn: (text: string) => api.addComment(selectedIssueId!, text, commentPublic),
    onSuccess: () => {
      setComment('')
      queryClient.invalidateQueries({ queryKey: ['comments', selectedIssueId] })
    },
  })

  /**
   * Смена статуса ВСЕГДА через модалку: там обязательный комментарий, дата
   * возврата и гард по типу заявки. Раньше «В работе» и «Ожидание ответа»
   * отправлялись из меню молча, а дата возврата подставлялась сама (+3 дня).
   */
  const openStatus = (code: string) => {
    const st = ALL_STATUSES.find(s => s.code === code)
    if (st) setPendingStatus(st)
  }

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
  const overdueLabel = (() => {
    if (!overdue || !od?.deadline_at) return null
    const days = Math.floor((Date.now() - new Date(od.deadline_at).getTime()) / 86_400_000)
    return days >= 1 ? `${days} д` : 'просрочено'
  })()
  // Телефон контакта живёт в кастом-параметрах Okdesk (та же тройка, что правится
  // в «Параметрах заявки») — отдельного поля в okdesk_detail нет.
  const contactPhone = od?.parameters.find(p => /телефон|тел\b|моб/i.test(p.name))?.value?.trim() || null
  const useBatch = isBatchIssue(issue, od?.description, extractableCount)
  // Без типа Okdesk не пускает заявку ни в «В работе», ни в «Решена» (проверка в
  // кнопке «Ответить и решить» ниже). Тем же условием раскрываем «Детали заявки»:
  // тип правится там, и оператор видит блокер сразу, а не по тосту в конце.
  const typeMissing = !od?.type_code || od.type_code === 'inner'
  // Счётчик секции «Детали заявки»: тип и заполненность обязательной тройки
  // параметров — то, из-за чего заявка застревает. Видно, не разворачивая блок.
  const paramsFilled = od
    ? EDITABLE_PARAMS.filter(ep => od.parameters.some(p => ep.match.test(p.name) && p.value?.trim())).length
    : 0
  const detailsLabel = od
    ? `${typeMissing ? 'тип не указан' : od.type_name} · параметры ${paramsFilled}/${EDITABLE_PARAMS.length}`
    : null
  // Уверенность и признак «можно авто» есть только у одиночного анализа: в пакетном
  // разборе бэкенд отдаёт по объекту вердикт и метрики, но не оценку уверенности.
  const singleAnalysis = automateCached?.cached ? (automateCached as unknown as AutomationResult) : null
  // Источник вердикта ВЫБРАННОЙ строки: от него зависит вид пилюли, полоса доверия
  // и наличие обоснования в блоке телеметрии (см. VerdictPill).
  const selectedSource: VerdictSource | null = selectedObj ? rowVerdictSource(selectedObj) : null
  // Уверенность, обоснование и черновик читаем ИЗ СТРОКИ: с per-object прогоном
  // (`POST /batch/ai`) они свои у каждого ТС. Фолбэк на сводный одиночный анализ —
  // для старых кэшей `automate`, где полей в строке ещё нет.
  const rowConfidence = selectedObj?.confidence ?? singleAnalysis?.confidence ?? null
  const rowReasoning = selectedObj?.reasoning ?? singleAnalysis?.reasoning ?? null
  const rowDraft = selectedObj?.draft_answer ?? singleAnalysis?.draft_answer ?? null
  // ИИ по ЭТОЙ строке уже отвечал. У строки, которую переписал оператор,
  // обоснование и черновик ИИ снимаются на бэкенде — там платная кнопка остаётся
  // доступной: прогон не перезаписывает ручные правки (такие строки в модель
  // просто не уходят), но добьёт обоснования по остальным объектам.
  const aiAnswered = selectedSource === 'ai'
  // Один вызов модели на всю заявку: число строк и режим берём из фактического
  // состава разбора, а не из наличия вложений.
  const aiObjectCount = parseRows.length || 1
  const aiIsBatch = parseRows.length >= 2
  // Регион — из кода в гос.номере выбранной (или первой) строки разбора.
  const regionLabel = plateRegion(selectedObj?.plate ?? parseRows[0]?.plate ?? null)

  return (
    <ActiveSectionContext.Provider value={activeSectionValue}>
    <div className="flex flex-col h-full">
      {/* ── Шапка v4: номер + статус + просрочка / тема / клиент · контакт ── */}
      <div className="shrink-0 bg-base border-b border-line px-4 pt-3.5 pb-3 flex flex-col gap-[7px] z-20">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <b className="text-[15px] font-bold leading-5 tabular-nums">#{issue.external_id}</b>
            <button
              onClick={() => {
                copyToClipboard(String(issue.external_id))
                setNumCopied(true)
                setTimeout(() => setNumCopied(false), 900)
              }}
              title={numCopied ? 'Скопировано' : 'Скопировать номер заявки'}
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-pill border transition-colors ${
                numCopied ? 'bg-accent border-accent text-black' : 'bg-frame border-border text-secondary hover:border-accent hover:text-accent'
              }`}
            >
              {numCopied ? <Check size={11} /> : <Copy size={11} />}
            </button>
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
                          className="w-full text-left px-4 py-2.5 text-xs font-medium border-l-4 hover:brightness-125 transition-all"
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
            {overdue && (
              <span
                title={`Дедлайн ${formatDate(od?.deadline_at) ?? '—'} — просрочено`}
                className="inline-flex items-center gap-1 shrink-0 rounded-pill bg-warning/15 px-2 py-0.5 text-[11px] font-medium leading-4 text-warning"
              >
                <AlertTriangle size={10} /> {overdueLabel}
              </span>
            )}
            {issue.priority && <span className="text-[11px] text-muted">{issue.priority}</span>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setDetailExpanded(!detailExpanded)}
              title={detailExpanded ? 'Вернуть список заявок' : 'Развернуть карточку на всю ширину'}
              className={`flex h-[27px] w-[27px] items-center justify-center rounded-pill border transition-colors ${detailExpanded ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-frame text-secondary hover:border-accent hover:text-accent'}`}
            >
              {detailExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={() => trackOpen ? setTrackOpen(false) : openTrack()}
              title={trackOpen ? 'Скрыть карту и графики' : 'Карта трека и графики телеметрии'}
              className={`flex h-[27px] w-[27px] items-center justify-center rounded-pill border transition-colors ${trackOpen ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-frame text-secondary hover:border-accent hover:text-accent'}`}
            >
              {trackOpen ? <PanelRightClose size={14} /> : <Map size={14} />}
            </button>
            {/* Адрес портала Okdesk знает только бэкенд (OKDESK_BASE_URL) —
                без него кнопку не показываем, чтобы не вести в никуда. */}
            {od?.okdesk_url && (
              <a
                href={od.okdesk_url}
                target="_blank"
                rel="noreferrer"
                title={`Открыть заявку #${issue.external_id} в Okdesk`}
                className="flex h-[27px] w-[27px] items-center justify-center rounded-pill border border-border bg-frame text-secondary hover:border-accent hover:text-accent transition-colors"
              >
                <ExternalLink size={14} />
              </a>
            )}
            <button
              onClick={() => selectIssue(null)}
              title="Закрыть карточку"
              className="flex h-[27px] w-[27px] items-center justify-center rounded-pill border border-border bg-frame text-secondary hover:border-accent hover:text-accent transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="text-[13px] font-medium leading-5">{issue.subject ?? '—'}</div>

        <div className="flex items-center gap-1.5 flex-wrap text-xs leading-[18px]">
          {issue.company_name && <span className="text-secondary">{issue.company_name}</span>}
          {issue.company_name && issue.contact_name && <span className="text-muted">·</span>}
          {issue.contact_name && <span className="font-medium text-white">{issue.contact_name}</span>}
          {!issue.company_name && !issue.contact_name && <span className="text-muted">Клиент не указан</span>}
          {contactPhone && (
            <button
              onClick={() => {
                copyToClipboard(contactPhone)
                setPhoneCopied(true)
                setTimeout(() => setPhoneCopied(false), 900)
              }}
              title={phoneCopied ? 'Скопировано' : `Скопировать телефон контакта: ${contactPhone}`}
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-pill border transition-colors ${
                phoneCopied ? 'bg-accent border-accent text-black' : 'bg-frame border-border text-secondary hover:border-accent hover:text-accent'
              }`}
            >
              {phoneCopied ? <Check size={10} /> : <Phone size={10} />}
            </button>
          )}
        </div>
      </div>

      {/* Тело карточки v4: ОДНА колонка, плоские секции на 1px-разделителях.
          Ширину панели задаёт App.tsx — процентных ширин внутри карточки нет. */}
      <div className="flex-1 issue-body">
        {resolveNotice && (
          <div className="flex items-start gap-2 bg-warning/10 border-b border-warning/30 px-4 py-2 text-xs text-warning">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="flex-1">{resolveNotice}</span>
            <button onClick={() => setResolveNotice(null)} className="shrink-0 text-warning/60 hover:text-warning"><X size={14} /></button>
          </div>
        )}

        {/* Вопрос клиента — исходный материал, до разбора ИИ */}
        <ClientQuestionBlock description={od?.description} source={od?.source} createdAt={issue.created_at} />

        {/* Детали заявки — свойства, участники, сроки, параметры. Второй сверху:
            без типа заявку не решить, а тип правится именно здесь (см. forceOpen). */}
        <Block
          title="Детали заявки"
          storageKey="details"
          defaultOpen={false}
          count={detailsLabel}
          forceOpen={od && typeMissing ? issue.id : null}
        >
          <div>
            <MetaRow label="Компания">{issue.company_name ?? '—'}</MetaRow>
            <MetaRow label="Контакт">{issue.contact_name ?? '—'}</MetaRow>
            <MetaRow label="Создана">{formatDate(issue.created_at) ?? '—'}</MetaRow>
          </div>

          {/* Live Okdesk info */}
          {od && <div className="mt-3"><OkdeskInfo d={od} issueId={issue.id} assigneeName={issue.assignee_name ?? null} /></div>}

          {/* Если okdesk_detail пустой — показываем только assignee picker */}
          {!od && (
            <div className="mt-3"><AssigneeSection issueId={issue.id} assigneeName={issue.assignee_name ?? null} /></div>
          )}
        </Block>

        {/* Вложения — файлы письма клиента */}
        <AttachmentsSection issueId={issue.id} />

        {/* Разбор — таблица объектов: одинаково для одного ТС и для двадцати */}
        <Block
          title="Разбор"
          storageKey="parse"
          count={selectedObj?.plate ? `выбран ${selectedObj.plate}` : null}
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
            onParse={(objects, note) => {
              setParseRows(objects)
              setBatchAiNote(note ?? null)
              // Строки обновились (прогон ИИ, правка номера/даты) — выбранный объект
              // должен показывать НОВЫЕ данные, а не копию до правки.
              setSelectedObj(prev => {
                if (selectedIdx != null && objects[selectedIdx]) return objects[selectedIdx]
                return prev
              })
            }}
            onUseDraft={text => { setComment(text); setCommentPublic(true); setBarExpanded(true) }}
          />
          <SingleParseTable
            issueId={issue.id}
            issueTitle={issue.subject}
            companyName={issue.company_name}
            onSelect={obj => { setSelectedIdx(0); setSelectedObj(obj); setParseRows([obj]) }}
          />
          <AutoAnalysis
            issueId={issue.id}
            issueTitle={issue.subject}
            companyName={issue.company_name}
          />
        </Block>

        {/* Телеметрия — по объекту, выбранному в таблице выше */}
        <Block
          title="Телеметрия"
          storageKey="telemetry"
          count={selectedObj?.plate ?? null}
          right={selectedObj?.date ? <span>за {selectedObj.date}</span> : undefined}
        >
          <TelemetryPanel
            telemetry={selectedObj?.telemetry ?? null}
            category={selectedObj?.verdict ?? null}
            confidence={rowConfidence}
            needsReview={singleAnalysis?.needs_review ?? false}
            autoEligible={singleAnalysis?.auto_eligible}
            subtitle={selectedObj?.plate ?? null}
            // Обоснование — только у вердикта ИИ: у правил и у ручной правки его нет,
            // а чужой текст от прошлого прогона объяснял бы не тот вердикт.
            reasoning={aiAnswered ? rowReasoning : null}
            verdictSource={selectedSource}
            heuristicCategory={selectedObj?.heuristic_category ?? null}
            editedBy={selectedObj?.verdict_edited_by ?? null}
            editedAt={formatDate(selectedObj?.verdict_edited_at) ?? null}
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

          {/* Платный шаг — на месте своих же результатов: пока ИИ не звали, здесь
              кнопка, после прогона — обоснование (в TelemetryPanel) и черновик. */}
          {selectedObj && !aiAnswered && (
            <AiAnswerCta issueId={issue.id} isBatch={aiIsBatch} objectCount={aiObjectCount} />
          )}
          {batchAiNote && (
            <p className="flex items-start gap-1.5 text-[11px] leading-4 text-muted">
              <Info size={13} className="mt-px shrink-0 text-info" /> {batchAiNote}
            </p>
          )}

          {aiAnswered && rowDraft && (
            <div className="space-y-1.5">
              <span className="block text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">
                Черновик ответа клиенту
              </span>
              {/* Флаги, из-за которых черновик нельзя отправлять «как есть». */}
              {singleAnalysis?.needs_remote_diagnostics && (
                <div className="flex items-start gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-[11px] leading-4 text-warning">
                  <AlertTriangle size={13} className="mt-px shrink-0" /> Требуется удалённая диагностика (клиент подтвердил питание)
                </div>
              )}
              {selectedObj?.spec_vehicle && (
                <div className="flex items-start gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-[11px] leading-4 text-warning">
                  <AlertTriangle size={13} className="mt-px shrink-0" /> Спецтехника — оценивать по факту работы
                </div>
              )}
              <p
                title="Черновик составлен ИИ для выбранного объекта"
                className="whitespace-pre-wrap rounded-[10px] border border-border bg-frame px-3 py-2.5 text-[13px] leading-5 text-secondary"
              >
                {rowDraft}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] leading-4 text-muted">Составлен ИИ — прочитайте перед отправкой</span>
                <button
                  onClick={() => { setComment(rowDraft); setBarExpanded(true) }}
                  title="Перенести черновик в поле ответа в нижнем баре"
                  className="shrink-0 rounded-pill border border-border bg-frame px-3 py-[5px] text-xs font-medium text-secondary hover:border-accent hover:text-accent transition-colors"
                >
                  Вставить в ответ
                </button>
              </div>
            </div>
          )}
        </Block>

        {/* Оценка разбора — петля обратной связи для обучения ИИ. Сразу после
            телеметрии: оценивают свежий разбор, а не переписку с клиентом. */}
        <Block
          title="Оценка разбора"
          storageKey="feedback"
          defaultOpen={false}
          count={feedbackLabel}
          right={<span>влияет на обучение ИИ</span>}
        >
          <AiFeedbackPanel issueId={issue.id} aiAnswered={aiAnswered} objectCount={aiObjectCount} />
        </Block>

        {/* Комментарии — только лента: составление ответа живёт в липком баре. */}
        <Block
          title="Комментарии"
          storageKey="comments"
          count={comments.length > 0 ? (allComments || comments.length === 1 ? comments.length : `${visibleComments.length} из ${comments.length}`) : null}
        >
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
                : 'bg-frame border-l-2 border-accent/40'
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
            {comments.length > COMMENTS_PREVIEW && (
              <button
                onClick={() => setAllComments(v => !v)}
                title={allComments ? `Оставить последние ${COMMENTS_PREVIEW}` : 'Показать всю переписку по заявке'}
                className="text-xs text-accent hover:underline"
              >
                {allComments ? `Свернуть до последних ${COMMENTS_PREVIEW}` : `Показать все ${comments.length} комментариев`}
              </button>
            )}
          </div>

        </Block>

        {/* Связанные заявки — навигация по родителю/дочерним */}
        {od && <RelatedIssuesSection d={od} onOpenExternal={openExternal} />}

        {/* Передать монтажникам — последняя секция: текст собирается по кнопке */}
        <InstallerSection key={issue.id} issueId={issue.id} />

        {/* Подвал с мета-данными: то, что нужно редко и не требует действий */}
        <div className="px-4 py-2.5 pb-4 text-[11px] leading-4 text-muted">
          {[
            issue.created_at ? `создана ${formatDate(issue.created_at)}` : null,
            od?.author_name || issue.contact_name || null,
            od?.deadline_at ? `дедлайн ${formatDate(od.deadline_at)}` : null,
            od?.type_name ? `тип «${od.type_name}»` : null,
            issue.assignee_name ? `ответственный ${issue.assignee_name}` : null,
            od?.source ? `источник ${od.source}` : null,
            // Регион выводим из кода в гос.номере — отдельного поля в системе нет.
            regionLabel ? `регион ${regionLabel}` : null,
          ].filter(Boolean).join(' · ')}
        </div>
      </div>

      {/* ── Липкий бар = БЫСТРЫЙ ОТВЕТ: единственная точка отправки ──
          Свёрнутый: поле «Ответить клиенту…» → «Шаблон ▾» → «Ответить и решить».
          По фокусу на поле раскрывается второй ряд. «Передать монтажникам» из
          бара убрано — это отдельная секция в конце карточки. */}
      <div className="shrink-0 border-t border-border bg-darker px-4 py-2.5 flex flex-col gap-2">
        {/* Гард живёт в баре ПОСТОЯННО, пока у заявки нет типа: тост показывался
            уже после нажатия, то есть оператор узнавал о блокере в последний
            момент. Чинится в «Деталях заявки» — секция раскрывается сама. */}
        {typeMissing && (
          <div
            title="Okdesk не примет смену статуса, пока у заявки тип «Не указан» — выберите тип в разделе «Детали заявки»"
            className="flex items-center gap-1.5 rounded-md bg-warning/15 px-2.5 py-1.5 text-[11px] leading-4 text-warning"
          >
            <AlertTriangle size={13} className="shrink-0" />
            Сначала укажите тип заявки — без типа Okdesk не пустит заявку ни в «В работе», ни в «Решена»
          </div>
        )}
        <div className="flex items-center gap-2">
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            onFocus={() => setBarExpanded(true)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment) addComment.mutate(comment)
            }}
            rows={1}
            placeholder="Ответить клиенту…"
            title="Ctrl+Enter — отправить комментарий без смены статуса"
            className={`flex-1 min-w-0 bg-frame border border-border text-[13px] leading-5 text-white placeholder:text-muted px-3.5 py-[7px] resize-none outline-none transition-all focus:border-accent ${barExpanded ? 'h-[84px] rounded-xl' : 'h-9 rounded-pill'}`}
          />

          <TemplatePicker trigger="text" onSelect={text => setComment(text)} issueId={issue.id} />

          {/* Главное действие ведёт в модалку решения, а не отправляет молча:
              комментарий уходит клиенту, и его надо увидеть целиком перед
              отправкой (в модалке же живёт гард по типу заявки). */}
          <button
            disabled={isDemo || typeMissing}
            onClick={() => openStatus('completed')}
            title={isDemo ? 'Недоступно в демо-режиме'
              : typeMissing ? 'Сначала укажите тип заявки — Okdesk не пустит заявку в «Решена»'
              : 'Отправить ответ клиенту и перевести заявку в «Решена»'}
            className={`flex shrink-0 items-center gap-1.5 rounded-pill bg-accent hover:bg-accent/90 text-black px-4 py-[7px] text-[13px] font-medium transition-colors disabled:opacity-40 ${isDemo || typeMissing ? 'cursor-not-allowed' : ''}`}
          >
            <Check size={14} /> Ответить и решить
          </button>
        </div>

        {barExpanded && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DraftChip
                  issueId={issue.id}
                  hasExtractable={useBatch}
                  plate={selectedObj?.plate ?? null}
                  draft={aiAnswered ? rowDraft : null}
                  onUseDraft={text => { setComment(text); setCommentPublic(true) }}
                />
                {/* Сегмент видимости: публичный ответ уходит клиенту */}
                <VisibilitySegments value={commentPublic} onChange={setCommentPublic} />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div className="relative">
                  <button
                    onClick={() => setMoreActionsOpen(v => !v)}
                    disabled={isDemo}
                    title={isDemo ? 'Недоступно в демо-режиме' : 'Другие действия: отправить комментарий, В работе, Ожидание ответа'}
                    className={`flex items-center gap-1 rounded-pill bg-frame border border-border px-3 py-[5px] text-xs font-medium text-secondary hover:border-muted hover:text-white transition-colors disabled:opacity-40 ${isDemo ? 'cursor-not-allowed' : ''}`}
                  >
                    Ещё <ChevronDown size={12} />
                  </button>
                  {moreActionsOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setMoreActionsOpen(false)} />
                      <div className="absolute right-0 bottom-full mb-1 z-50 w-[288px] rounded-md overflow-hidden border border-border bg-frame shadow-lg">
                        <button
                          disabled={!comment || addComment.isPending}
                          onClick={() => { setMoreActionsOpen(false); addComment.mutate(comment) }}
                          title="Отправить комментарий, не меняя статус (Ctrl+Enter)"
                          className="w-full flex items-center justify-between gap-2 border-b border-line px-3 py-2.5 text-left text-[13px] hover:bg-card-hover disabled:opacity-40"
                        >
                          <span className="flex items-center gap-2"><Send size={13} className="text-secondary" /> Отправить комментарий</span>
                          <span className="text-[10px] leading-[14px] text-muted">без смены статуса</span>
                        </button>
                        {BAR_MENU_ACTIONS.map(a => {
                          const st = ALL_STATUSES.find(s => s.code === a.code)
                          if (!st) return null
                          const Icon = a.code === 'wait' ? Play : Pause
                          return (
                            <button
                              key={a.code}
                              onClick={() => { setMoreActionsOpen(false); openStatus(a.code) }}
                              title={`Перевести в «${a.label}» — откроется окно с комментарием${st.needsDelay ? ' и датой возврата' : ''}`}
                              className="w-full flex items-center justify-between gap-2 border-b border-line px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-card-hover disabled:opacity-40"
                            >
                              <span className="flex items-center gap-2">
                                <Icon size={13} style={{ color: STATUS_COLOR[a.code as keyof typeof STATUS_COLOR] }} /> {a.label}
                              </span>
                              <span className="text-[10px] leading-[14px] text-muted">{a.hint}</span>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setBarExpanded(false)}
                  title="Свернуть поле ответа"
                  className="flex items-center rounded-pill bg-frame border border-border px-3 py-[5px] text-xs font-medium text-secondary hover:border-muted hover:text-white transition-colors"
                >
                  Свернуть
                </button>
              </div>
            </div>
            <p className="text-[10px] leading-4 text-muted">
              {commentPublic
                ? 'Ответ уйдёт клиенту публичным комментарием'
                : 'Приватный — виден только сотрудникам'}
              {' · Ctrl+Enter — отправить комментарий без смены статуса'}
            </p>
          </>
        )}
      </div>
    </div>

    {pendingStatus && od && (
      <StatusActionModal
        issueId={issue.id}
        externalId={issue.external_id}
        targetStatus={pendingStatus}
        typeMissing={typeMissing && pendingStatus.code !== 'opened'}
        initialComment={comment}
        initialPublic={commentPublic}
        onClose={() => setPendingStatus(null)}
        onDone={(notice) => {
          setPendingStatus(null)
          setComment('')       // ответ ушёл — поле не должно предлагать отправить его ещё раз
          setBarExpanded(false)
          if (notice) setResolveNotice(notice)
        }}
      />
    )}

    {toast && (
      <div className="fixed bottom-5 right-5 z-[60] flex items-center gap-2 bg-warning text-black text-xs font-semibold px-4 py-2.5 rounded-lg shadow-lg">
        <AlertTriangle size={14} /> {toast}
      </div>
    )}
    </ActiveSectionContext.Provider>
  )
}
