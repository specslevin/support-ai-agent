import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useMemo, useEffect, useRef, useId, createContext, useContext, Fragment } from 'react'
import {
  ChevronDown, AlertTriangle, X, Check, Star, Bot, RefreshCw, Database,
  Lightbulb, Map, FilePlus, ExternalLink, Pause, Send,
  Layers, FileText,
  PanelRightClose, Info, MessageSquare, Sparkles, Wand2,
  Maximize2, Minimize2,
  Loader2, Lock, User, Headset, Play, ThumbsUp, ThumbsDown,
  Copy, Calendar, Phone, Pencil, MoreHorizontal, ChevronsDownUp,
  Plus, Trash2,
} from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import { useUserStore } from '../store/userStore'
import { useAuthStore } from '../store/authStore'
import { StatusBadge } from './StatusBadge'
import { EmployeeMenu, TypeMenu } from './pickers'
import type {
  OkdeskDetail, Template, AutomationResult, AutomationParsed, BatchResult, BatchObject,
  ParseResult, VerdictSource, IssueAttachment, RelatedIssue,
} from '../types'
import {
  extractPlaceholders, hasPlaceholders, renderTemplate,
  computedPlaceholderValue, isComputedPlaceholder, todayIsoMsk,
} from '../lib/templates'
import { STATUS_COLOR, statusPillStyle } from '../lib/status'
import {
  TelemetryPanel, VerdictPill, VERDICT_TEXT_STYLE, IssueIntentChip,
  normalizeVerdictSource, verdictSourceHint, verdictDisagreement,
  isNonMileageVerdict, isServiceVerdict, NON_MILEAGE_HINT,
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

  // Сырые значения по КОДАМ: `d.parameters` — витрина для человека (прячет мусор,
  // подставляет телефон из «Контактного лица»), и форма по ней показывала бы
  // заполненным поле, которое в Okdesk пусто. Фолбэк на матч по имени — для
  // ответов бэкенда без `editable_parameters`.
  const initial = useMemo(() => {
    const out: Record<string, string> = { address: '', contact_person: '', tel_person: '' }
    for (const ep of EDITABLE_PARAMS) {
      const byCode = d.editable_parameters?.find(p => p.code === ep.code)
      out[ep.code] = byCode
        ? byCode.value
        : (d.editable_parameters ? '' : (d.parameters.find(p => ep.match.test(p.name))?.value ?? ''))
    }
    return out
  }, [d.editable_parameters, d.parameters])

  const [vals, setVals] = useState<Record<string, string>>(initial)
  // Ключ — по значениям, а не по ссылке на массив: react-query отдаёт новый объект
  // на каждый фоновый рефетч, и сброс по ссылке стирал бы уже набранный текст.
  const initialKey = JSON.stringify(initial)
  useEffect(() => { setVals(initial) }, [initialKey])  // eslint-disable-line react-hooks/exhaustive-deps

  // «Есть что отправить» = ровно то, что уйдёт в payload: очистка поля не считается
  // правкой (Okdesk обязательный атрибут пустым не примет).
  const dirty = EDITABLE_PARAMS.some(ep => {
    const val = (vals[ep.code] ?? '').trim()
    return !!val && val !== (initial[ep.code] ?? '')
  })

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, string> = {}
      for (const ep of EDITABLE_PARAMS) {
        const val = (vals[ep.code] ?? '').trim()
        // Пустое значение обязательного атрибута Okdesk отклоняет (422): стереть
        // поле через API нельзя, только заменить — такие правки не отправляем.
        if (val && val !== (initial[ep.code] ?? '')) payload[ep.code] = val
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

/**
 * Поля заявки в Okdesk. Правится ТОЛЬКО тема — остальное на просмотр.
 *
 * Срок, приоритет и плановая продолжительность жили здесь как поля правки, но
 * уходили общим `PATCH /issues/{id}`, который Okdesk молча игнорирует (200 и
 * никаких изменений). У них есть свои эндпоинты (`/deadlines`, `/priorities`,
 * `/planned_execution_in_minutes`), и бэкенд их уже умеет — но нашему API-ключу
 * Okdesk отвечает на них 403: права даются роли сотрудника, к которому привязан
 * ключ. Пока прав нет, поле правки только обманывает оператора, поэтому здесь
 * оно показано текстом. Появятся права — вернуть правку (бэкенд менять не нужно).
 *
 * Правка темы тихая (макет .inl): поле выглядит текстом, обводка появляется по
 * клику, сохранение по Enter / потере фокуса, отмена по Escape.
 *
 * Наблюдатели, оборудование и объект обслуживания тоже правятся через API, но
 * требуют выбора сущностей Okdesk (свои справочники) — заведём отдельно.
 * Компанию и контакт сознательно не даём менять: подмену клиента у живой заявки
 * не откатить, а «быстрой правкой» это не бывает.
 */
function EditableOkdeskFields({ d, issueId, subject }: {
  d: OkdeskDetail
  issueId: number
  subject: string | null
}) {
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef(false)

  // Справочник нужен только для ИМЕНИ приоритета: в заявке лежит код.
  const { data: priorities = [] } = useQuery({
    queryKey: ['priorities'],
    queryFn: () => api.listPriorities(),
    staleTime: 30 * 60_000,
  })

  const save = useMutation({
    mutationFn: (fields: Parameters<typeof api.updateIssueFields>[1]) =>
      api.updateIssueFields(issueId, fields),
    onSettled: () => setSaving(null),
    onSuccess: () => {
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issues'] })
    },
    onError: (e) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(detail || 'Не удалось сохранить поле в Okdesk')
    },
  })

  const commit = (key: string, fields: Parameters<typeof api.updateIssueFields>[1]) => {
    setSaving(key)
    save.mutate(fields)
  }

  const priorityName = priorities.find(p => p.code === d.priority_code)?.name ?? d.priority_code ?? '—'
  // Почему эти три поля только на просмотр — одна подпись на все, чтобы оператор
  // не искал кнопку правки и знал, куда идти.
  const readOnlyHint = 'Правится только в Okdesk: у нашего API-ключа нет права менять это поле'

  const inlineClass = 'min-w-0 flex-1 -ml-2 rounded-pill border border-transparent bg-transparent px-2 py-[3px] text-xs leading-[18px] text-white outline-none transition-colors hover:border-line focus:border-accent focus:bg-frame disabled:cursor-not-allowed disabled:opacity-55'

  return (
    <Section title="Поля Okdesk" defaultOpen={false} storageKey="okdesk-fields">
      <div>
        <div className="flex items-center gap-2.5 border-b border-line py-[7px]">
          <span className="w-[148px] shrink-0 text-[9px] font-medium uppercase leading-3 tracking-[0.4px] text-muted">
            Тема заявки
          </span>
          <input
            type="text"
            defaultValue={subject ?? ''}
            key={`subj-${subject ?? ''}`}
            disabled={isDemo || saving === 'title'}
            title={isDemo ? 'Недоступно в демо-режиме' : 'Тема заявки в Okdesk — Enter сохраняет, Esc отменяет'}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') { cancelRef.current = true; (e.target as HTMLInputElement).blur() }
            }}
            onBlur={e => {
              const val = e.target.value.trim()
              if (cancelRef.current) { cancelRef.current = false; e.target.value = subject ?? ''; return }
              if (!val || val === (subject ?? '')) return
              commit('title', { title: val })
            }}
            className={inlineClass}
          />
          {saving === 'title' && <Loader2 size={12} className="shrink-0 animate-spin text-muted" />}
        </div>

        {/* Срок, приоритет и продолжительность — ТОЛЬКО просмотр: Okdesk не даёт
            нашему ключу их менять (403), а поле правки, которое ничего не меняет,
            хуже отсутствия поля. Кнопка «открыть в Okdesk» — в шапке карточки. */}
        <MetaRow label="Срок выполнения" title={`deadline_at — от него считается просрочка и сортировка списка. ${readOnlyHint}`}>
          {formatDate(d.deadline_at) || '—'}
        </MetaRow>
        <MetaRow label="Приоритет" title={`priority — код приоритета Okdesk. ${readOnlyHint}`}>
          {priorityName}
        </MetaRow>
        <MetaRow label="Плановая продолжительность" title={`planned_execution_in_hours — плановая продолжительность работ. ${readOnlyHint}`}>
          {d.planned_execution_in_hours != null ? `${d.planned_execution_in_hours} ч` : '—'}
        </MetaRow>
      </div>
      {error && <p className="text-[11px] text-orange-400">{error}</p>}
      <p className="text-[10px] leading-4 text-muted">
        Правится только тема: Enter или уход из поля сохраняет, Esc отменяет. Срок, приоритет и
        плановую продолжительность Okdesk нашему API-ключу менять не даёт (403 — право выдаётся роли
        сотрудника, к которому привязан ключ), поэтому они показаны на просмотр — менять их в Okdesk.
        Наблюдатели, оборудование и объект обслуживания правятся через API, но требуют выбора из
        справочников Okdesk — сделаем отдельно. Компанию и контакт менять не даём: подмену клиента
        у живой заявки не откатить.
      </p>
    </Section>
  )
}

// Связанные заявки отсюда вынесены в RelatedIssuesSection (блок рельса v3),
// поэтому onOpenExternal этому компоненту больше не нужен.
function OkdeskInfo({ d, issueId, assigneeName, subject }: { d: OkdeskDetail; issueId: number; assigneeName: string | null; subject: string | null }) {
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

      {/* Поля Okdesk, правимые через API: тема, срок, приоритет, плановая длительность */}
      <EditableOkdeskFields d={d} issueId={issueId} subject={subject} />

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
        {/* Иконка, а не «Шаблон ▾»: подпись отбирала ширину у поля ответа. */}
        <button
          onClick={() => (open ? closePicker() : setOpen(true))}
          title="Шаблон ответа — шаблон с плейсхолдерами запросит значения"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-pill border transition-colors ${
            open ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-frame text-secondary hover:border-muted hover:text-white'
          }`}
        >
          <FileText size={14} />
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
 * Главное действие бара — «Ответить и решить». Ведёт в модалку решения, а не
 * отправляет молча: комментарий уходит клиенту, его надо увидеть целиком (в
 * модалке же гард по типу заявки). Текст оставлен — это единственная кнопка бара,
 * смысл которой нельзя прятать в тултип.
 */
function ResolveButton({ disabled, isDemo, typeMissing, onClick }: {
  disabled: boolean
  isDemo: boolean
  typeMissing: boolean
  onClick: () => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={isDemo ? 'Недоступно в демо-режиме'
        : typeMissing ? 'Сначала укажите тип заявки — Okdesk не пустит заявку в «Решена»'
        : 'Отправить ответ клиенту и перевести заявку в «Решена»'}
      className={`flex shrink-0 items-center gap-1.5 rounded-pill bg-accent hover:bg-accent/90 text-black px-3.5 py-[6px] text-[13px] font-medium transition-colors disabled:opacity-40 ${disabled ? 'cursor-not-allowed' : ''}`}
    >
      <Check size={14} /> Ответить и решить
    </button>
  )
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
function useFreeParse(issueId: number, enabled = true, postOnMiss = true) {
  return useQuery<ParseResult & { cached?: boolean; created_at?: string }>({
    queryKey: ['parse-free', issueId],
    queryFn: async () => {
      const cached = await api.getCachedParse(issueId)
      if (cached.cached) return cached
      // Промах без права на прогон: карточка уже рисуется из кэша `automate`, и
      // читать `parse` мы пришли только за ручными правками. Считать их «нет» —
      // верно; гонять полный разбор на каждое открытие такой карточки — нет.
      if (!postOnMiss) return cached
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
  // Служебные — в хвост: по ним клиенту не отвечают (см. SERVICE_VERDICTS).
  'Не заявка о расхождении пробега', 'Ложный пробег / экранирование',
  'Номер не распознан', 'Нет даты', 'Нет номера/даты', 'Ошибка данных',
]

/**
 * Сводка разбора: «Всего N: вердикт × k» + бейдж «ИИ не вызывался», пока ни один
 * вердикт в таблице не получен от DeepSeek. Одна реализация на обе таблицы.
 */
function ParseSummary({ objects, total, intent }: {
  objects: BatchObject[]
  total?: number
  /** `parsed.issue_intent` — ярлык «про что заявка», если она не о пробеге. */
  intent?: string | null
}) {
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
      {/* Почему заявка не о пробеге — сразу в шапке разбора, до таблицы. */}
      <IssueIntentChip intent={intent} />
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
  { label: 'ПЛ', title: 'Пробег по путевому листу, км (у спецтехники вместо километров — моточасы, «м/ч»)' },
  { label: 'ГЛОНАСС', title: 'ГЛОНАСС заявл. — заявленный пробег по системе, км' },
  { label: 'Факт', title: 'По факту — пробег по треку, км' },
  { label: 'Вердикт', title: 'Вердикт ИИ — можно изменить' },
]

/**
 * Пункты нативного списка вердиктов. Цвет и фон — инлайном: option наследуют цвет
 * от прозрачного select-оверлея, из-за чего список был чёрным по чёрному.
 */
const VERDICT_OPTION_STYLE: React.CSSProperties = { color: '#FFFFFF', backgroundColor: '#1E1E1E' }

/** actions — сколько служебных колонок без подписи идёт справа (трек, дочерняя). */
function ParseTableHead({ actions }: { actions: number }) {
  return (
    <thead className="text-muted">
      <tr className="text-left">
        {PARSE_COLUMNS.map(c => (
          <th key={c.label} title={c.title} className="font-medium py-1.5 pr-2 whitespace-nowrap">
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

/** Вердикты, которые оператор может поставить руками (общий список обеих таблиц). */
const ALLOWED_VERDICTS = ['Глушение', 'Данные верны', 'Не было питания', 'Нет данных', 'Терминал подключился', 'Проверить'] as const

/** HTTP-код ошибки axios без импорта самого axios (нужен только для разбора ответа). */
function apiStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status
}

/** Текст ошибки бэкенда: `detail` уже по-русски — показываем оператору как есть. */
function apiErrorText(e: unknown, fallback: string): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  return typeof detail === 'string' && detail.trim() ? detail : fallback
}

/** Правимые колонки пробега: «ПЛ» и «ГЛОНАСС заявл.» — одна механика, разные поля. */
const MILEAGE_FIELDS = {
  sheet: {
    editTitle: 'Изменить пробег по путевому листу (км) — вердикт строки пересчитается',
    editedTitle: 'Пробег по путевому листу изменён оператором',
  },
  declared: {
    editTitle: 'Изменить заявленный пробег по системе (км) — вердикт строки пересчитается',
    editedTitle: 'Заявленный пробег изменён оператором',
  },
} as const
type MileageField = keyof typeof MILEAGE_FIELDS

/** Тело `POST /batch/mileage` без селектора строки. */
type MileagePatch = {
  sheet_mileage_km?: number
  declared_system_km?: number
  clear_sheet?: boolean
  clear_declared?: boolean
}

/**
 * Ввод пробега → что отправлять бэкенду.
 *
 * `null` — значение не изменилось, запрос не нужен. Клиенты пишут «80,79» и
 * «1 234,5», поэтому пробелы выкидываем, запятую приводим к точке. Пустой ввод
 * значит «стереть»: `null` в поле бэкенд трактует как «не менять», стирание идёт
 * отдельным флагом `clear_*`.
 */
function mileageChange(o: BatchObject, field: MileageField, raw: string):
  { patch: MileagePatch } | { error: string } | null {
  const current = (field === 'sheet' ? o.sheet_mileage_km : o.declared_system_km) ?? null
  const val = raw.trim().replace(/\s/g, '').replace(',', '.')
  if (!val) {
    if (current == null) return null
    return { patch: field === 'sheet' ? { clear_sheet: true } : { clear_declared: true } }
  }
  const num = Number(val)
  if (!Number.isFinite(num)) return { error: `«${raw.trim()}» — не похоже на число. Пробег вводится в км, например 80,79` }
  if (num < 0) return { error: 'Пробег не может быть отрицательным' }
  if (num === current) return null
  return { patch: field === 'sheet' ? { sheet_mileage_km: num } : { declared_system_km: num } }
}

/** Что оператор правил в строке руками — подписи для предупреждения о переразборе. */
function manualEditLabels(o: BatchObject): string[] {
  const what: string[] = []
  if (o.manual_row) what.push('строка заведена вручную')
  if (o.plate_edited) what.push('номер')
  if (o.date_edited) what.push('дата')
  if (o.mileage_edited) what.push('пробег')
  if (o.verdict_edited || rowVerdictSource(o) === 'operator') what.push('вердикт')
  return what
}

/**
 * Строки с ручными правками. Форс-прогон разбора перезаписывает документ целиком,
 * поэтому перед ним оператору показываем поимённо, что именно пропадёт.
 */
function manualEditedRows(objects: BatchObject[]): { obj: BatchObject; what: string[] }[] {
  return objects
    .map(obj => ({ obj, what: manualEditLabels(obj) }))
    .filter(r => r.what.length > 0)
}

/**
 * Моточасы рядом с колонкой «ПЛ». У спецтехники клиент пишет «ПЛ-1 м/ч» вместо
 * километров, а в табличных вложениях («Группировка», колонка «Моточасы») они
 * приезжают своей графой — показываем отдельной пометкой, чтобы м/ч никогда не
 * читались как км и не попадали в поле правки пробега оператором (там
 * по-прежнему только километры). Пусто — ничего не рисуем.
 */
function EngineHoursMark({ hours }: { hours?: number | null }) {
  if (hours == null || !Number.isFinite(hours)) return null
  return (
    <span
      title="Моточасы (спецтехника) — из путевого листа или из колонки «Моточасы» вложения. Это не километры: в пробег они не подставляются"
      className="shrink-0 whitespace-nowrap text-[10px] text-secondary"
    >
      {hours} м/ч
    </span>
  )
}

/**
 * «Год исправлен» рядом с датой неисправности (`parsed.date_year_fixed`). Клиент
 * пишет «01.07.2028» или прошлогоднюю дату — разбор подставляет год заявки. Это
 * НАША догадка, а не текст клиента, поэтому оператор должен видеть её отдельно.
 * Пометка тихая: без цвета-тревоги, расшифровка — в тултипе. Поле необязательное
 * (старые кэши его не несут) — `undefined` значит «ничего не показывать».
 */
function YearFixedMark({ on }: { on?: boolean }) {
  if (!on) return null
  return (
    <span
      title="Год в дате исправлен разбором: клиент указал год, которого не может быть у этой заявки. Это догадка системы — проверьте по письму и при необходимости поправьте дату"
      className="shrink-0 whitespace-nowrap text-[9px] uppercase leading-3 tracking-[0.4px] text-muted"
    >
      год испр.
    </span>
  )
}

/**
 * Относится ли сводный признак «год исправлен» к ЭТОЙ строке. Признак живёт в
 * сводных фактах заявки (`parsed`), а строк в разборе может быть двадцать —
 * помечаем только строку с той же датой и только пока её не правил оператор
 * (его дату мы не угадывали). Признака нет (старый кэш) → `false`.
 */
function yearFixedFor(
  parsed: AutomationParsed | null | undefined,
  o: BatchObject,
): boolean {
  if (!parsed?.date_year_fixed || o.date_edited) return false
  return !!o.date && !!parsed.date && o.date === parsed.date
}

/**
 * Ячейка гос.номера, даты или пробега с правкой по карандашу (клик по карандашу,
 * а не по тексту — защита от случайного изменения; Enter применяет, Esc отменяет).
 *
 * Один компонент на обе таблицы разбора: раньше эта разметка была скопирована
 * дважды и успела разойтись мелочами.
 *
 * `kind='number'` — пробег: ввод свободный текстом (клиенты пишут «80,79»),
 * запятую в точку и проверку на число делает обработчик таблицы. Пустой ввод для
 * пробега осмыслен — это «стереть значение», поэтому он тоже уходит в onApply.
 */
function ParseEditCell({ kind, value, saving, edited, manual, readOnly, emptyLabel, editTitle, editedTitle, suffix, onApply }: {
  kind: 'plate' | 'date' | 'number'
  value: string | null
  /** Идёт сохранение этой ячейки — поле блокируется, рядом крутится ↻. */
  saving?: boolean
  /** Значение уже правил оператор (`plate_edited` / `date_edited`). */
  edited?: boolean
  /** Всю строку завёл оператор (`manual_row`) — помечаем только у номера. */
  manual?: boolean
  /** Демо-режим или строка без номера — только просмотр. */
  readOnly?: boolean
  emptyLabel: string
  editTitle: string
  editedTitle: string
  /**
   * Пометка справа от значения — только для чтения (в правку не попадает).
   * Нужна колонке «ПЛ»: у спецтехники рядом с километрами живут моточасы.
   */
  suffix?: React.ReactNode
  onApply: (val: string) => void
}) {
  const [editing, setEditing] = useState(false)
  // Отмена по Escape: blur происходит и при Esc, поэтому применение гасим флагом.
  const cancelRef = useRef(false)

  const mark = manual ? (
    <span title="Строка добавлена оператором" className="inline-flex shrink-0 text-info"><Plus size={10} /></span>
  ) : null

  // Пустой пробег — обычное дело (в акте его может и не быть), а пустой номер или
  // дата это дырка в разборе: предупреждением подсвечиваем только их.
  const emptyClass = kind === 'number' ? 'text-muted' : 'text-warning'

  if (readOnly) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className={value ? '' : emptyClass}>{value ?? '—'}</span>
        {suffix}
        {mark}
      </span>
    )
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <input
          {...(kind === 'date' ? { type: 'date' } : {})}
          {...(kind === 'number' ? { inputMode: 'decimal' as const, placeholder: '0' } : {})}
          autoFocus
          defaultValue={value ?? ''}
          disabled={saving}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'Escape') { cancelRef.current = true; (e.target as HTMLInputElement).blur() }
          }}
          onBlur={e => {
            const val = e.target.value
            setEditing(false)
            if (cancelRef.current) { cancelRef.current = false; return }
            onApply(val)
          }}
          className={`rounded border border-accent bg-frame px-1 py-0.5 text-[11px] text-white outline-none placeholder:text-muted/40 disabled:opacity-50 ${
            kind === 'plate' ? 'w-[5.5rem] font-mono' : kind === 'number' ? 'w-[4.5rem]' : 'w-[8.5rem]'
          }`}
        />
        <span className="shrink-0 text-[9px] text-muted/60">
          {kind === 'number' ? 'Enter / Esc · пусто = стереть' : 'Enter / Esc'}
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className={value ? '' : emptyClass}>{value ?? emptyLabel}</span>
      {suffix}
      <button
        onClick={e => { e.stopPropagation(); setEditing(true) }}
        title={editTitle}
        className="shrink-0 text-muted/40 hover:text-accent transition-colors"
      ><Pencil size={11} /></button>
      {edited && <span title={editedTitle} className="shrink-0 text-info">●</span>}
      {mark}
      {saving && <span className="shrink-0 animate-spin text-muted">↻</span>}
    </span>
  )
}

/**
 * Ячейка вердикта: пилюля с источником (правила / ИИ / оператор) и прозрачный
 * нативный `select` поверх неё — так остаётся штатный выпадающий список без
 * своей вёрстки (таблица лежит в overflow-x-auto, свой попап там обрезался бы).
 *
 * Один компонент на обе таблицы: правка вердикта была только в пакетной, в
 * одиночной висела read-only пилюля.
 */
function VerdictCell({ o, loading, readOnly, onChange }: {
  o: BatchObject
  loading?: boolean
  /** Демо-режим — только просмотр. */
  readOnly?: boolean
  onChange: (verdict: string) => void
}) {
  const spec = o.spec_vehicle ? (
    <span
      title="Спецтехника без км-пробега — оценивать по факту работы/моточасам"
      className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-pill bg-warning/15 text-warning text-[9px] font-medium align-middle"
    >
      спецтехника
    </span>
  ) : null

  // Заявка не о расхождении пробега — предупреждаем прямо в строке: отвечать по
  // пробеговому шаблону нельзя, телеметрия ниже остаётся только справкой.
  const service = isNonMileageVerdict(o.verdict) ? (
    <span
      title={NON_MILEAGE_HINT}
      className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-pill border border-border text-secondary text-[9px] font-medium uppercase leading-3 tracking-[0.4px] align-middle"
    >
      не о пробеге
    </span>
  ) : null

  if (readOnly) {
    return <><VerdictPill verdict={o.verdict} source={rowVerdictSource(o)} />{service}{spec}</>
  }

  const d = verdictDisagreement(o.verdict, o.heuristic_category, rowVerdictSource(o))
  return (
    <>
      <span className="inline-flex min-w-0 items-center">
        <span className="relative inline-flex min-w-0 items-center rounded-pill focus-within:ring-1 focus-within:ring-accent">
          <VerdictPill
            verdict={o.verdict}
            source={rowVerdictSource(o)}
            className={loading ? 'opacity-50' : ''}
            title={verdictCellHint(o)}
          />
          <span className="ml-1.5 shrink-0 text-[11px] text-muted">▾</span>
          {/* Список вердиктов был НЕВИДИМ: у select стоял text-transparent (чтобы
              не просвечивал поверх пилюли), а option наследуют цвет от select —
              в раскрытом списке получался чёрный текст на чёрном. Цвет каждого
              пункта задаём инлайном (VERDICT_OPTION_STYLE). */}
          <select
            value={o.verdict}
            disabled={loading}
            onChange={e => onChange(e.target.value)}
            onClick={e => e.stopPropagation()}
            title={verdictCellHint(o)}
            aria-label="Вердикт по объекту"
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent opacity-0 outline-none disabled:cursor-wait"
          >
            {ALLOWED_VERDICTS.map(v => (
              <option key={v} value={v} style={VERDICT_OPTION_STYLE}>{v}</option>
            ))}
            {!ALLOWED_VERDICTS.includes(o.verdict as typeof ALLOWED_VERDICTS[number]) && (
              <option value={o.verdict} style={VERDICT_OPTION_STYLE}>{o.verdict}</option>
            )}
          </select>
        </span>
        {d && (
          <span title={`Правила: ${d.from} → ${d.by}: ${d.to}`} className="ml-1.5 shrink-0 text-[11px] text-muted">⇄</span>
        )}
        {loading && <span className="ml-1.5 shrink-0 animate-spin text-muted">↻</span>}
      </span>
      {service}
      {spec}
    </>
  )
}

/** Кнопка удаления строки разбора — иконка того же размера, что соседние в строке. */
function DeleteRowButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); if (!disabled) onClick() }}
      disabled={disabled}
      // Единственную строку бэкенд удалять запрещает (пустой разбор он считает
      // отсутствующим) — не даём оператору упереться в отказ после подтверждения.
      title={disabled
        ? 'Единственную строку разбора удалить нельзя — используйте «Обновить разбор»'
        : 'Удалить строку из разбора'}
      className={`inline-flex transition-colors ${disabled ? 'cursor-not-allowed text-muted/25' : 'text-muted/50 hover:text-red-400'}`}
    ><Trash2 size={14} /></button>
  )
}

/**
 * Инлайн-форма «+ Добавить ТС»: гос.номер + дата неисправности. Нужна, когда
 * OCR не увидел акт (или ТС нет в письме) — оператор заводит строку сам.
 */
function AddRowForm({ defaultDate, onAdd, onCancel }: {
  defaultDate: string
  /** Промис отклонён → форму НЕ закрываем: оператор поправит номер и повторит. */
  onAdd: (plate: string, date: string) => Promise<void>
  onCancel: () => void
}) {
  const [plate, setPlate] = useState('')
  const [date, setDate] = useState(defaultDate)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const p = plate.trim().toUpperCase()
    if (!p || !date || pending) return
    setPending(true)
    setError(null)
    try {
      await onAdd(p, date)
    } catch (e) {
      setError(apiErrorText(e, `Не удалось добавить ${p} — проверьте номер и дату.`))
      setPending(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
    else if (e.key === 'Escape') { e.preventDefault(); if (!pending) onCancel() }
  }

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-frame px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          autoFocus
          value={plate}
          disabled={pending}
          placeholder="А123ВС163"
          onChange={e => setPlate(e.target.value)}
          onKeyDown={onKey}
          aria-label="Гос.номер"
          className="w-[7rem] rounded border border-border bg-darker px-1.5 py-1 font-mono text-[11px] text-white outline-none placeholder:text-muted/50 focus:border-accent disabled:opacity-50"
        />
        <input
          type="date"
          value={date}
          disabled={pending}
          onChange={e => setDate(e.target.value)}
          onKeyDown={onKey}
          aria-label="Дата неисправности"
          className="w-[8.5rem] rounded border border-border bg-darker px-1.5 py-1 text-[11px] text-white outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          onClick={submit}
          disabled={pending || !plate.trim() || !date}
          className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
        >
          {pending ? <Working label="Добавляю…" /> : 'Добавить'}
        </button>
        <button
          onClick={onCancel}
          disabled={pending}
          className="text-[11px] text-muted transition-colors hover:text-white disabled:opacity-40"
        >Отмена</button>
        <span className="shrink-0 text-[9px] text-muted/60">Enter / Esc</span>
      </div>
      {error && <p className="text-[11px] leading-4 text-orange-400">{error}</p>}
    </div>
  )
}

/**
 * Подтверждение удаления строки разбора. Готового ConfirmDialog в проекте нет —
 * скелет и стили от StatusActionModal (оверлей + карточка + подвал с кнопками).
 */
function DeleteRowDialog({ obj, onConfirm, onCancel }: {
  obj: BatchObject
  /** Промис отклонён → окно остаётся открытым с текстом ошибки бэкенда (в т.ч. 409). */
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc = отмена, но не посреди запроса (иначе оператор закроет окно на полпути).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, onCancel])

  const run = async () => {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      // Успех — окно размонтируется родителем, состояние трогать уже нельзя.
    } catch (e) {
      setError(apiErrorText(e, 'Не удалось удалить строку. Попробуйте снова.'))
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/70" onClick={() => !pending && onCancel()} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Удалить строку разбора?</h2>
          <button onClick={() => !pending && onCancel()} className="text-muted hover:text-white"><X size={18} /></button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p className="text-xs leading-relaxed text-secondary">
            Из таблицы уйдёт объект{' '}
            <b className="font-mono font-medium text-white">{obj.plate ?? 'без номера'}</b>
            {obj.date && <> за <b className="font-medium text-white">{obj.date}</b></>}
            {obj.file && <> (источник — <span className="text-muted">{obj.file}</span>)</>}.
          </p>
          <p className="flex items-start gap-2 rounded-md bg-warning/15 px-3 py-2 text-[11px] leading-4 text-warning">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span>Удаление действует только на текущий разбор: «Обновить разбор» вернёт строку, если она снова найдётся в акте.</span>
          </p>
          {error && <p className="text-[11px] leading-4 text-orange-400">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <button
            onClick={onCancel}
            disabled={pending}
            className="text-xs text-muted transition-colors hover:text-white disabled:opacity-40"
          >Отмена</button>
          <button
            onClick={run}
            disabled={pending}
            className={`flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/15 px-4 py-2 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-50 ${pending ? 'cursor-wait' : ''}`}
          >
            {pending ? <Working label="Удаляю…" /> : <><Trash2 size={14} /> Удалить строку</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Предупреждение перед форс-прогоном разбора. Прогон собирает документ заново из
 * вложений и молча затирает ручные правки — окно называет их поимённо, чтобы
 * оператор решал осознанно. Сохранения правок тут нет и быть не может: разбор
 * либо старый с правками, либо новый без них.
 */
function RerunConfirmDialog({ rows, onConfirm, onCancel }: {
  rows: { obj: BatchObject; what: string[] }[]
  onConfirm: () => void
  onCancel: () => void
}) {
  // Esc = отмена. Прогон запускает родитель и сам показывает его прогресс, так
  // что окно закрывается сразу по подтверждению — ждать здесь нечего.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/70" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Обновить разбор?</h2>
          <button onClick={onCancel} className="text-muted hover:text-white"><X size={18} /></button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p className="flex items-start gap-2 rounded-md bg-warning/15 px-3 py-2 text-[11px] leading-4 text-warning">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span>
              Разбор соберётся заново из вложений, ручные правки при этом пропадут —
              сохранить их нельзя. Правлено вручную строк: {rows.length}.
            </span>
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-[11px] leading-4 text-secondary">
            {rows.map(({ obj, what }, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                <b className="font-mono font-medium text-white">{obj.plate ?? 'без номера'}</b>
                {obj.date && <span className="text-muted">{obj.date}</span>}
                <span>— {what.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <button
            onClick={onCancel}
            className="text-xs text-muted transition-colors hover:text-white"
          >Отмена</button>
          <button
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/15 px-4 py-2 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/25"
          ><RefreshCw size={14} /> Обновить разбор</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Тихое предложение отметить ошибку ИИ: строка под тем объектом, у которого
 * оператор только что переписал вердикт ИИ. Такая правка — готовый обучающий
 * сигнал, но уходит он ТОЛЬКО по клику: сами ничего не отправляем.
 */
function AiMissPrompt({ issueId, verdict, colSpan, onHide }: {
  issueId: number
  /** Новый вердикт оператора — он и едет в оценку как правильная категория. */
  verdict: string
  colSpan: number
  onHide: () => void
}) {
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    if (pending || sent) return
    setPending(true)
    setError(null)
    try {
      await api.addAiFeedback(issueId, { rating: 'bad', error_kind: 'wrong_verdict', correct_category: verdict })
      setSent(true)
    } catch (e) {
      // Предложение оставляем на месте — оператор может повторить отправку.
      setError(apiErrorText(e, 'Не удалось отправить оценку. Попробуйте ещё раз.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <tr>
      <td colSpan={colSpan} className="pb-1.5">
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-4 text-muted">
          {sent ? (
            <span className="inline-flex items-center gap-1 text-green-400">
              <Check size={11} className="shrink-0" /> Отмечено: ИИ ошибся, верно «{verdict}»
            </span>
          ) : (
            <>
              <button
                onClick={e => { e.stopPropagation(); send() }}
                disabled={pending}
                title={`Отправить в «Оценки ИИ»: вердикт ИИ неверный, правильный — «${verdict}»`}
                className="inline-flex items-center gap-1 text-muted transition-colors hover:text-accent disabled:opacity-50"
              >
                {pending ? <Working label="Отмечаю…" /> : <><ThumbsDown size={11} className="shrink-0" /> ИИ ошибся? Отметить</>}
              </button>
              <button
                onClick={e => { e.stopPropagation(); onHide() }}
                title="Скрыть предложение"
                className="inline-flex text-muted/40 transition-colors hover:text-white"
              ><X size={11} /></button>
            </>
          )}
          {error && <span className="text-orange-400">{error}</span>}
        </span>
      </td>
    </tr>
  )
}

/** Кнопка под таблицей разбора: раскрывает инлайн-форму добавления объекта. */
function AddRowButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Добавить объект в разбор вручную (акт не распознан или ТС нет в письме)"
      className="inline-flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-accent"
    ><Plus size={12} /> Добавить ТС</button>
  )
}

/** Полный ИИ-прогон → строка таблицы разбора того же формата, что у пакетной. */
function rowFromAutomate(res: AutomationResult): BatchObject {
  const t = res.telemetry
  return {
    file: '', plate: res.parsed?.plate ?? null, date: res.parsed?.date ?? null,
    sheet_mileage_km: res.parsed?.sheet_mileage_km ?? null,
    // Моточасы спецтехники: едут отдельным полем, в километры их не превращаем.
    engine_hours: res.parsed?.engine_hours ?? null,
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
  /** Выбранная строка наверх — вместе со всем списком (оператор может добавить ТС). */
  onSelect?: (obj: BatchObject | null, idx: number, objects: BatchObject[]) => void
}) {
  const queryClient = useQueryClient()
  const isDemo = useAuthStore(s => s.user?.role === 'demo')
  // Какая ячейка сейчас сохраняется: ключ `${idx}:plate|date|sheet|declared`.
  const [savingCell, setSavingCell] = useState<string | null>(null)
  const [verdictLoading, setVerdictLoading] = useState<number | null>(null)
  // Строки, где оператор только что переписал вердикт ИИ → предложение отметить
  // ошибку модели. Ключ — индекс строки, значение — новый вердикт. Живёт до
  // перезагрузки/смены заявки: это подсказка, а не состояние заявки.
  const [aiMiss, setAiMiss] = useState<Record<number, string>>({})
  // Правка, ради которой придётся пересобрать разбор (см. RerunConfirmDialog).
  const [pendingRefine, setPendingRefine] = useState<{ idx: number; field: 'plate' | 'date'; val: string } | null>(null)
  // Выбранная строка: строк может быть больше одной — оператор добавляет ТС руками.
  const [selIdx, setSelIdx] = useState(0)
  const [rowError, setRowError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null)
  // Разбор `parse` перебивает кэш `automate`: после ручной правки (вердикт,
  // добавленная/удалённая строка) свежие данные лежат именно в нём.
  const [parseEdited, setParseEdited] = useState(false)

  const { isBatch, ready, cachedBatchObjects } = useBatchMode(issueId, issueTitle, companyName)

  // Ключи состояния завязаны на конкретную заявку — при смене сбрасываем.
  useEffect(() => {
    setSavingCell(null)
    setVerdictLoading(null)
    setSelIdx(0)
    setRowError(null)
    setAddOpen(false)
    setDeleteIdx(null)
    setParseEdited(false)
    setAiMiss({})
    setPendingRefine(null)
  }, [issueId])

  const automateQ = useQuery({
    queryKey: ['automate-cached', issueId],
    queryFn: () => api.getCachedAutomate(issueId),
    staleTime: 5 * 60_000,
  })
  const automate = automateQ.data?.cached ? (automateQ.data as unknown as AutomationResult) : null

  // Бесплатный разбор зовём только там, где он реально нужен: заявка одиночная,
  // режим уже известен, а полного ИИ-прогона в кэше нет (он богаче и главнее).
  // При наличии `automate` разбор всё равно читаем — но ТОЛЬКО из кэша: там могут
  // лежать ручные правки оператора, а без них таблица после F5 показывала бы
  // вердикт до правки (правки пишутся в `parse`, а рисовали мы `automate`).
  const freeQ = useFreeParse(issueId, ready && !isBatch && automateQ.isSuccess, !automate)
  const free = freeQ.data
  // Правка этой сессии или отметка бэкенда о правке в прошлой — одинаково означают,
  // что авторитетен `parse`.
  const parseWins = parseEdited || Boolean(free?.operator_touched)

  // Строки таблицы: обычно одна — ИИ-прогон (богаче) либо бесплатный разбор. После
  // ручной правки строк источник только один — документ `parse` (в нём и правки,
  // и добавленные оператором объекты, которых кэш `automate` не знает).
  const freeRows = free?.objects ?? []
  const rows: BatchObject[] = (!automate || parseWins) && freeRows.length
    ? freeRows
    : automate ? [rowFromAutomate(automate)] : []
  // Что именно перезапишет переанализ: пересобирается документ `parse`, значит и
  // ручные правки искать надо в нём, а не в строке из кэша `automate`.
  const riskRows = freeRows.length ? freeRows : rows
  // Сводные факты (ярлык «про что заявка», правка года в дате) берём из того же
  // источника, что и строки таблицы, — иначе шапка описывала бы другой разбор.
  const parsed = ((!automate || parseWins) && freeRows.length ? free?.parsed : automate?.parsed)
    ?? free?.parsed ?? automate?.parsed ?? null

  /** Ответ batch-эндпоинта → кэш бесплатного разбора: он и рисует таблицу после правки. */
  const putParse = (data: BatchResult) => {
    // Мержим в существующий документ: ответ batch-эндпоинта не содержит `parsed`,
    // а он лежит в кэше `parse-free` и нужен остальным читателям.
    queryClient.setQueryData(
      ['parse-free', issueId],
      (prev: (ParseResult & { cached?: boolean }) | undefined) => ({ ...(prev ?? {}), ...data, cached: true }),
    )
    setParseEdited(true)
  }

  /**
   * Правка строки одиночного разбора. Особый случай: таблица нарисована из кэша
   * `automate`, а документа `parse` ещё нет — бэкенд отвечает 400 «Сначала
   * выполните разбор по вложениям». Тогда создаём его бесплатным разбором (ноль
   * токенов DeepSeek) и повторяем запрос ОДИН раз; второй отказ показываем как есть.
   */
  const withParseDoc = async (send: () => Promise<BatchResult>): Promise<BatchResult> => {
    try {
      return await send()
    } catch (e) {
      // Ровно этот отказ, а не любой 400: остальные (недопустимый вердикт, дубль
      // строки) — по делу, и перезапуск разбора затёр бы правки оператора.
      if (apiStatus(e) !== 400 || !apiErrorText(e, '').startsWith('Сначала выполните разбор')) throw e
      await api.parseIssue(issueId)
      return await send()
    }
  }

  // Уточнение номера/даты = перепроверка ТС в гео по исправленным данным. Пока ИИ
  // не звали, правка идёт бесплатным `parse` — незачем платить за опечатку клиента.
  const refine = useMutation<AutomationResult | ParseResult, unknown, { plate?: string; date?: string }>({
    mutationFn: (override) =>
      automate ? api.automateIssue(issueId, override) : api.parseIssue(issueId, override),
    onSettled: () => setSavingCell(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automate-cached', issueId] })
      queryClient.invalidateQueries({ queryKey: ['parse-free', issueId] })
      queryClient.invalidateQueries({ queryKey: ['issue', issueId] })
      // Трек мог быть закэширован с ошибкой «номер не найден» до правки — сбрасываем.
      queryClient.invalidateQueries({ queryKey: ['track', issueId] })
    },
  })

  /**
   * Правка номера/даты. Нетронутый одиночный разбор (ровно одна строка) правим
   * переанализом, как и раньше. Как только оператор начал править сам документ
   * разбора (добавил строку, поменял вердикт), все правки идут в него же
   * batch-эндпоинтом по индексу: переанализ пересобрал бы документ и потерял их.
   */
  const applyEdit = async (idx: number, field: 'plate' | 'date', raw: string) => {
    const o = rows[idx]
    const val = raw.trim()
    const current = (field === 'plate' ? o?.plate : o?.date) ?? ''
    if (!o || !val || val === current) return
    if (rows.length === 1 && !parseWins) {
      // Переанализ пересобирает документ разбора. Правки в нём обычно уводят нас в
      // ветку ниже (parseWins), но у старых кэшей нет `operator_touched` — прежде
      // чем затирать их молча, спрашиваем.
      if (manualEditedRows(riskRows).length) { setPendingRefine({ idx, field, val }); return }
      setSavingCell(`${idx}:${field}`)
      refine.mutate({ [field]: val })
      return
    }
    setSavingCell(`${idx}:${field}`)
    setRowError(null)
    try {
      const updated = await withParseDoc(() => field === 'plate'
        ? api.updateBatchPlate(issueId, o.plate ?? '', val.toUpperCase(), o.date || undefined, o.file || undefined, idx)
        : api.updateBatchDate(issueId, val, o.plate, o.date, o.file || undefined, idx))
      putParse(updated)
    } catch (e) {
      setRowError(apiErrorText(e, field === 'plate'
        ? `Не удалось обновить номер на ${val} — проверьте, найден ли он в гео.`
        : `Не удалось обновить дату на ${val} — проверьте данные ТС в гео.`))
    } finally {
      setSavingCell(null)
    }
  }

  /**
   * Правка пробега («ПЛ» / «ГЛОНАСС заявл.»): клиент нередко ошибается в цифре, а
   * от неё зависит вердикт. Переанализом это не правят — только документ разбора,
   * иначе потерялись бы остальные правки. Бэкенд после записи сам пересчитывает
   * вердикт строки по правилам, поэтому таблицу целиком берём из его ответа.
   */
  const applyMileage = async (idx: number, field: MileageField, raw: string) => {
    const o = rows[idx]
    if (!o) return
    const change = mileageChange(o, field, raw)
    if (!change) return
    if ('error' in change) { setRowError(change.error); return }
    setSavingCell(`${idx}:${field}`)
    setRowError(null)
    try {
      const updated = await withParseDoc(() =>
        api.updateBatchMileage(issueId, change.patch, { index: idx, plate: o.plate, date: o.date, file: o.file || undefined }))
      putParse(updated)
    } catch (e) {
      setRowError(apiErrorText(e, `Не удалось сохранить пробег для ${o.plate ?? 'строки без номера'}.`))
    } finally {
      setSavingCell(null)
    }
  }

  // Правка вердикта — тот же эндпоинт, что у пакетной таблицы: он умеет писать и в
  // документ одиночного разбора. Источник вердикта станет «оператор».
  const handleVerdictChange = async (idx: number, newVerdict: string) => {
    const o = rows[idx]
    if (!o?.plate) return
    // Источник ДО правки: если вердикт ставил ИИ, правка оператора — обучающий сигнал.
    const wasAi = rowVerdictSource(o) === 'ai'
    setVerdictLoading(idx)
    setRowError(null)
    try {
      const plate = o.plate
      const updated = await withParseDoc(() =>
        api.updateBatchVerdict(issueId, plate, newVerdict, o.file || undefined, o.date || undefined))
      putParse(updated)
      if (wasAi) setAiMiss(prev => ({ ...prev, [idx]: newVerdict }))
    } catch (e) {
      setRowError(apiErrorText(e, `Не удалось сохранить вердикт для ${o.plate}`))
    } finally {
      setVerdictLoading(null)
    }
  }

  const addRow = async (plate: string, date: string) => {
    const updated = await withParseDoc(() => api.addBatchRow(issueId, plate, date))
    setRowError(null)
    putParse(updated)
    setAddOpen(false)
  }

  const deleteRow = async (idx: number) => {
    const o = rows[idx]
    if (!o) return
    const updated = await withParseDoc(() =>
      api.deleteBatchRow(issueId, idx, o.plate, o.date, o.file || undefined))
    setRowError(null)
    putParse(updated)
    setDeleteIdx(null)
    // Предложения «ИИ ошибся» привязаны к индексам строк — после удаления они
    // сдвигаются, и оценка ушла бы не про тот объект. Проще снять их все.
    setAiMiss({})
    // Выбор не должен показывать телеметрию удалённого ТС: сдвигаем или прижимаем
    // к последней оставшейся строке (наверх уедет через эффект ниже).
    setSelIdx(prev => prev > idx ? prev - 1 : Math.min(prev, Math.max(updated.objects.length - 1, 0)))
  }

  // Строку отдаём наверх, чтобы блок телеметрии показывал этот же объект
  // (вместе с источником вердикта — от него зависит вид пилюли и полоса доверия).
  useEffect(() => {
    if (!onSelect) return
    // Таблицу ведёт пакетный разбор — тогда и объект выбирает он, иначе телеметрия
    // показала бы строку, которой на экране нет.
    if (isBatch || cachedBatchObjects >= 1) return
    if (!rows.length) { onSelect(null, 0, []); return }
    const i = Math.min(selIdx, rows.length - 1)
    onSelect(rows[i], i, rows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automate, free, parseWins, selIdx, isBatch, cachedBatchObjects])

  // Пакетная заявка (в т.ч. когда пакетный разбор уже дал строки) рисует таблицу
  // сама — двух таблиц об одном и том же в карточке быть не должно.
  if (isBatch || cachedBatchObjects >= 1) return null
  // Режим ещё не известен — не показываем ни таблицу, ни кнопку добавления
  // (иначе «+ Добавить ТС» мигал бы до загрузки разбора).
  if (!ready || !automateQ.isSuccess) return null

  if (!rows.length && freeQ.isFetching) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <Loader2 size={12} className="animate-spin shrink-0" /> Разбираю факты заявки…
      </p>
    )
  }

  // Правка строк доступна оператору, но не демо-витрине.
  const canEdit = !isDemo
  const multi = rows.length > 1
  const delObj = deleteIdx != null ? rows[deleteIdx] : null

  return (
    <>
    {rows.length > 0 ? (
      <>
        <ParseSummary objects={rows} total={rows.length} intent={parsed?.issue_intent} />
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <ParseTableHead actions={canEdit ? 2 : 1} />
            <tbody>
              {rows.map((o, idx) => (
                <Fragment key={idx}>
                <tr
                  onClick={() => multi && setSelIdx(idx)}
                  title={multi ? 'Показать телеметрию этого ТС' : undefined}
                  className={`border-t border-line ${multi ? 'cursor-pointer' : ''} ${
                    multi && selIdx === idx ? 'bg-accent/10 border-l-2 border-l-accent' : multi ? 'hover:bg-card-hover/60' : ''
                  }`}
                >
                  <td className="py-2 pr-2 font-mono">
                    <ParseEditCell
                      kind="plate"
                      value={o.plate}
                      readOnly={isDemo}
                      saving={savingCell === `${idx}:plate`}
                      edited={o.plate_edited}
                      manual={o.manual_row}
                      emptyLabel="нет номера"
                      editTitle={o.plate ? 'Изменить гос.номер и перепроверить ТС в гео' : 'Вписать гос.номер вручную и проверить в гео'}
                      editedTitle="Номер изменён оператором, перепроверено в гео"
                      onApply={val => applyEdit(idx, 'plate', val)}
                    />
                  </td>
                  <td className="pr-2">
                    <ParseEditCell
                      kind="date"
                      value={o.date}
                      readOnly={isDemo}
                      saving={savingCell === `${idx}:date`}
                      edited={o.date_edited}
                      emptyLabel="нет даты"
                      editTitle="Изменить дату неисправности и перепроверить в гео"
                      editedTitle="Дата изменена оператором, перепроверено в гео"
                      /* Год в дате подставили мы, а не клиент — помечаем только
                         ту строку, к дате которой относится сводный признак. */
                      suffix={<YearFixedMark on={yearFixedFor(parsed, o)} />}
                      onApply={val => applyEdit(idx, 'date', val)}
                    />
                  </td>
                  <td className="pr-2">
                    <ParseEditCell
                      kind="number"
                      value={o.sheet_mileage_km != null ? String(o.sheet_mileage_km) : null}
                      readOnly={isDemo}
                      saving={savingCell === `${idx}:sheet`}
                      edited={o.mileage_edited}
                      emptyLabel="—"
                      editTitle={MILEAGE_FIELDS.sheet.editTitle}
                      editedTitle={MILEAGE_FIELDS.sheet.editedTitle}
                      suffix={<EngineHoursMark hours={o.engine_hours} />}
                      onApply={val => applyMileage(idx, 'sheet', val)}
                    />
                  </td>
                  <td className="pr-2">
                    <ParseEditCell
                      kind="number"
                      value={o.declared_system_km != null ? String(o.declared_system_km) : null}
                      readOnly={isDemo}
                      saving={savingCell === `${idx}:declared`}
                      edited={o.mileage_edited}
                      emptyLabel="—"
                      editTitle={MILEAGE_FIELDS.declared.editTitle}
                      editedTitle={MILEAGE_FIELDS.declared.editedTitle}
                      onApply={val => applyMileage(idx, 'declared', val)}
                    />
                  </td>
                  <td className="pr-2 text-white font-medium">{o.system_mileage_km ?? o.telemetry?.system_mileage_km ?? '—'}</td>
                  <td className="pr-2">
                    <VerdictCell
                      o={o}
                      readOnly={isDemo}
                      loading={verdictLoading === idx}
                      onChange={v => handleVerdictChange(idx, v)}
                    />
                  </td>
                  <td className="pr-1 text-center">
                    <TrackLink plate={o.plate ?? null} date={o.date ?? null} />
                  </td>
                  {canEdit && (
                    <td className="text-center">
                      <DeleteRowButton disabled={rows.length === 1} onClick={() => setDeleteIdx(idx)} />
                    </td>
                  )}
                </tr>
                {aiMiss[idx] && (
                  <AiMissPrompt
                    issueId={issueId}
                    verdict={aiMiss[idx]}
                    colSpan={PARSE_COLUMNS.length + (canEdit ? 2 : 1)}
                    onHide={() => setAiMiss(prev => { const n = { ...prev }; delete n[idx]; return n })}
                  />
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <ParseDisagreeNote objects={rows} />
        <ParseTableNote />
      </>
    ) : (
      /* Разбор состоялся, но номер не нашёлся — объясняем причину вместо пустоты. */
      free?.note ? <p className="text-[11px] leading-4 text-muted">{free.note}</p> : null
    )}
    {canEdit && (addOpen ? (
      <div className="mt-1.5">
        <AddRowForm defaultDate={rows[0]?.date || todayIsoMsk()} onAdd={addRow} onCancel={() => setAddOpen(false)} />
      </div>
    ) : (
      <div className="mt-1.5"><AddRowButton onClick={() => setAddOpen(true)} /></div>
    ))}
    {rowError && <p className="mt-1 text-xs text-orange-400">{rowError}</p>}
    {delObj && (
      <DeleteRowDialog
        obj={delObj}
        onConfirm={() => deleteRow(deleteIdx!)}
        onCancel={() => setDeleteIdx(null)}
      />
    )}
    {pendingRefine && (
      <RerunConfirmDialog
        rows={manualEditedRows(riskRows)}
        onConfirm={() => {
          const { idx, field, val } = pendingRefine
          setPendingRefine(null)
          setSavingCell(`${idx}:${field}`)
          refine.mutate({ [field]: val })
        }}
        onCancel={() => setPendingRefine(null)}
      />
    )}
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
/** Пункт меню чипа ответа: подпись + короткое пояснение справа. */
function AnswerMenuItem({ label, hint, disabled, onClick }: {
  label: string
  hint: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left text-xs last:border-b-0 hover:bg-card-hover disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="min-w-0 text-white">{label}</span>
      <span className="shrink-0 text-[10px] leading-[14px] text-muted">{hint}</span>
    </button>
  )
}

/**
 * Чип «По правилам» — ответ БЕЗ модели и без токенов. Два охвата: один текст по
 * всем объектам (гос.номера группируются по вердикту в коде) или текст по
 * выбранной строке (шаблон её категории с датой и пробегом).
 *
 * Раньше этот путь прятался за чипом «✦ черновик ИИ», из-за чего оператор получал
 * ответ по правилам, думая, что его написала модель.
 */
function RulesAnswerChip({ issueId, objectCount, selectedIdx, plate, date, serviceVerdict, onUseDraft }: {
  issueId: number
  objectCount: number
  selectedIdx: number | null
  plate?: string | null
  date?: string | null
  /**
   * У выбранной строки СЛУЖЕБНЫЙ вердикт (заявка не о пробеге либо разбор не
   * состоялся). Ответ по пробеговому шаблону такой строке не подходит — путь
   * «только по этому ТС» закрываем, чтобы оператор не отправил клиенту чужой текст.
   */
  serviceVerdict?: boolean
  onUseDraft: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const compose = useMutation({
    mutationFn: (scope: 'all' | 'object') =>
      api.composeAnswer(issueId, scope === 'all'
        ? { scope: 'all' }
        : { scope: 'object', index: selectedIdx ?? undefined, plate, date }),
    onSuccess: (data) => { if (data.answer) onUseDraft(data.answer) },
  })
  const pick = (scope: 'all' | 'object') => { setOpen(false); compose.mutate(scope) }
  // Один объект — выбирать нечего, вставляем сразу без меню.
  const single = objectCount <= 1
  // Единственная строка со служебным вердиктом: предлагать по ней шаблон нечего —
  // чип гаснет и объясняет причину. У многообъектной заявки чип живёт: сводный
  // ответ «по всем» остаётся законным, закрыт только пункт «только по этому ТС».
  const blocked = !!serviceVerdict && single

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => (single ? pick('object') : setOpen(v => !v))}
        disabled={compose.isPending || blocked}
        title={blocked
          ? 'Заявка не о расхождении пробега (или разбор не состоялся) — готового ответа по правилам для неё нет, отвечает оператор'
          : 'Ответ по правилам: формулировки готовые, модель не вызывается — бесплатно'}
        className={`flex shrink-0 items-center gap-1 rounded-pill border border-border bg-frame px-2.5 py-[3px] text-[11px] font-medium text-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-secondary ${compose.isPending ? 'animate-pulse cursor-wait' : ''}`}
      >
        {compose.isPending
          ? <Working label="Собираю…" />
          : <><Layers size={11} /> по правилам{single ? '' : ' ▾'}</>}
      </button>
      {open && !single && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[300px] overflow-hidden rounded-xl border border-border bg-darker shadow-lg">
            <AnswerMenuItem
              label={`По всем объектам (${objectCount})`}
              hint="группировка по вердиктам"
              onClick={() => pick('all')}
            />
            <AnswerMenuItem
              label={plate ? `Только по ${plate}` : 'Только по выбранному ТС'}
              hint={serviceVerdict
                ? 'вердикт служебный — шаблона нет'
                : plate ? 'шаблон категории' : 'сначала выберите строку'}
              disabled={serviceVerdict || (!plate && selectedIdx == null)}
              onClick={() => pick('object')}
            />
          </div>
        </>
      )}
      {compose.isError && <p className="text-[11px] text-orange-400">Не удалось собрать ответ. Попробуйте снова.</p>}
    </div>
  )
}

/**
 * Чип «✦ ИИ» — вставка текстов, которые написала модель. Ничего не запрашивает:
 * тексты приходят одним платным вызовом из «Телеметрии» («Ответ ИИ») и лежат в
 * разборе. Пока вызова не было — чип погашен и объясняет, куда нажать.
 */
function AiAnswerChip({ draft, summary, plate, onUseDraft }: {
  draft?: string | null
  summary?: string | null
  plate?: string | null
  onUseDraft: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const has = !!draft || !!summary
  const single = !summary || !draft
  const only = draft || summary || ''

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => (single ? (has && onUseDraft(only)) : setOpen(v => !v))}
        disabled={!has}
        title={has
          ? 'Вставить текст, составленный ИИ'
          : 'ИИ по этой заявке не вызывали — нажмите «Ответ ИИ» в блоке «Телеметрия»'}
        className={`flex shrink-0 items-center gap-1 rounded-pill border px-2.5 py-[3px] text-[11px] font-medium transition-colors ${
          has ? 'border-accent bg-accent/15 text-accent hover:bg-accent hover:text-black'
              : 'cursor-not-allowed border-border bg-frame text-muted opacity-60'
        }`}
      >
        <Sparkles size={11} /> ИИ{has && !single ? ' ▾' : ''}
      </button>
      {open && has && !single && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[300px] overflow-hidden rounded-xl border border-border bg-darker shadow-lg">
            <AnswerMenuItem
              label={plate ? `Черновик по ${plate}` : 'Черновик по выбранному ТС'}
              hint="по одной строке"
              disabled={!draft}
              onClick={() => { setOpen(false); if (draft) onUseDraft(draft) }}
            />
            <AnswerMenuItem
              label="Сводный по всей заявке"
              hint="написан моделью"
              disabled={!summary}
              onClick={() => { setOpen(false); if (summary) onUseDraft(summary) }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function BatchAnalysis({ issueId, issueTitle, issueDescription, onOpenExternal, selectedIdx, onSelectObject, onParse }: {
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
  onParse?: (
    objects: import('../types').BatchObject[],
    meta?: { aiNote?: string | null; aiSummary?: string | null; intent?: string | null },
  ) => void
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
  const [dateLoading, setDateLoading] = useState<Set<string>>(new Set())
  const [dateError, setDateError] = useState<string | null>(null)
  // Ключ занятой ячейки пробега — `${ключ строки}:sheet|declared` (в строке две
  // правимые колонки, спиннер должен крутиться только в своей).
  const [mileageLoading, setMileageLoading] = useState<Set<string>>(new Set())
  const [mileageError, setMileageError] = useState<string | null>(null)
  // Строки, где оператор только что переписал вердикт ИИ → предложение отметить
  // ошибку модели. Ключ строки → новый вердикт; живёт до перезагрузки страницы.
  const [aiMiss, setAiMiss] = useState<Record<string, string>>({})
  // Открыто предупреждение «переразбор затрёт ручные правки».
  const [rerunOpen, setRerunOpen] = useState(false)
  // Инлайн-форма «+ Добавить ТС» и строка, для которой открыто окно удаления.
  const [addOpen, setAddOpen] = useState(false)
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null)
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
    setMileageError(null)
    setAddOpen(false)
    setDeleteIdx(null)
    setAiMiss({})
    setRerunOpen(false)
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

  /**
   * Разбор — один источник правды: кэш запроса. Все правки пишут сюда же.
   * Мержим в предыдущий документ: ответы эндпоинтов правки строк не несут сводных
   * фактов (`parsed`), и без мержа после правки пробега со всей шапки пропадал бы
   * ярлык «про что заявка».
   */
  const putBatch = (data: BatchResult) => {
    queryClient.setQueryData(
      ['batch-cached', issueId],
      (prev: (BatchResult & { cached?: boolean }) | undefined) =>
        ({ ...(prev ?? {}), cached: true, ...data, parsed: data.parsed ?? prev?.parsed ?? null }),
    )
  }

  // Строки разбора наружу: карточке нужно их число (один вызов ИИ на все объекты)
  // и звали ли ИИ — от этого зависит платная кнопка в «Телеметрии». Эффект стоит
  // ДО любых ранних выходов: хуки не могут вызываться условно.
  const reportRows = cached?.objects ?? null
  const reportNote = cached?.ai_note ?? null
  const reportSummary = cached?.ai_summary_answer ?? null
  // Ярлык «про что заявка» нужен и блоку телеметрии — он живёт в карточке.
  const reportIntent = cached?.parsed?.issue_intent ?? null
  useEffect(() => {
    if (reportRows) onParse?.(reportRows, { aiNote: reportNote, aiSummary: reportSummary, intent: reportIntent })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportRows, reportNote, reportSummary, reportIntent])

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
  const startRun = () => {
    cancelOcrLoop()
    ocrRoundsRef.current = 0
    lastPagesRef.current = -1
    setAutoOcr(true)
    clearBatchChildren(issueId)
    run.mutate()
  }

  /**
   * Клик по кнопке разбора. Повторный прогон собирает документ заново и молча
   * затирает ручные правки — если они есть, сперва предупреждаем. Правок нет —
   * запускаем сразу, лишний клик оператору не нужен.
   */
  const requestRun = () => {
    if (manualEditedRows(cached?.objects ?? []).length) { setRerunOpen(true); return }
    startRun()
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

  /**
   * Ручная правка пробега: «ПЛ» из акта и «ГЛОНАСС заявл.» — те самые числа, из-за
   * расхождения которых заведена заявка, и OCR их путает не реже номера. Бэкенд
   * после записи пересчитывает вердикт строки по правилам, поэтому таблицу целиком
   * берём из его ответа.
   */
  const handleMileageChange = async (o: import('../types').BatchObject, field: MileageField, raw: string, idx: number) => {
    const change = mileageChange(o, field, raw)
    if (!change) return
    if ('error' in change) { setMileageError(change.error); return }
    const key = `${rowKey(o, idx)}:${field}`
    setMileageLoading(prev => new Set([...prev, key]))
    setMileageError(null)
    try {
      const updated = await api.updateBatchMileage(issueId, change.patch, {
        index: idx, plate: o.plate, date: o.date, file: o.file || undefined,
      })
      putBatch(updated)
    } catch (e) {
      setMileageError(apiErrorText(e, `Не удалось сохранить пробег для ${o.plate ?? 'строки без номера'}.`))
    } finally {
      setMileageLoading(prev => { const s = new Set(prev); s.delete(key); return s })
    }
  }

  // Оператор заводит объект вручную: OCR не увидел акт или ТС нет в письме.
  // Ошибку показывает сама форма — она же остаётся открытой для повторной попытки.
  const addRow = async (plate: string, date: string) => {
    const updated = await api.addBatchRow(issueId, plate, date)
    putBatch(updated)
    setAddOpen(false)
  }

  // Удаление строки: index сверяется на бэкенде с номером/датой/файлом (409, если
  // список успел разойтись). Ошибку показывает окно подтверждения.
  const deleteRow = async (idx: number, o: import('../types').BatchObject) => {
    const updated = await api.deleteBatchRow(issueId, idx, o.plate, o.date, o.file || undefined)
    putBatch(updated)
    setDeleteIdx(null)
    // Ключ строки содержит её индекс — после удаления он сдвигается, и предложение
    // «ИИ ошибся» повисло бы на чужом объекте. Снимаем все.
    setAiMiss({})
    // Телеметрия ниже не должна показывать удалённый ТС: сдвигаем выбор.
    if (selectedIdx != null) {
      if (selectedIdx === idx) onSelectObject?.(Math.max(0, Math.min(idx, updated.objects.length - 1)), updated.objects)
      else if (selectedIdx > idx) onSelectObject?.(selectedIdx - 1, updated.objects)
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

  const handleVerdictChange = async (o: import('../types').BatchObject, newVerdict: string, idx: number) => {
    if (!o.plate) return
    // Ключ строки (idx|номер|дата|файл) — правка и спиннер строго по этой строке.
    const key = rowKey(o, idx)
    // Источник ДО правки: если вердикт ставил ИИ, правка оператора — обучающий сигнал.
    const wasAi = rowVerdictSource(o) === 'ai'
    setVerdictLoading(prev => new Set([...prev, key]))
    setVerdictError(null)
    try {
      const updated = await api.updateBatchVerdict(issueId, o.plate, newVerdict, o.file || undefined, o.date || undefined)
      putBatch(updated)
      if (wasAi) setAiMiss(prev => ({ ...prev, [key]: newVerdict }))
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
          onClick={requestRun}
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
          <ParseSummary objects={res.objects} total={res.total} intent={res.parsed?.issue_intent} />
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <ParseTableHead actions={isDemo ? 2 : 3} />
              <tbody>
                {res.objects.map((o, idx) => {
                  const key = rowKey(o, idx)
                  const rc = o.plate ? rowCreated[key] : null
                  const isLoading = !!o.plate && loadingPlates.has(key)
                  const isVerdictLoading = !!o.plate && verdictLoading.has(key)
                  const isPlateLoading = plateLoading.has(key)
                  return (
                    <Fragment key={idx}>
                    <tr
                      onClick={() => onSelectObject?.(idx, res.objects)}
                      title="Показать телеметрию этого ТС"
                      className={`border-t border-line cursor-pointer ${
                        trackOpen && trackPlate === o.plate && trackDate === o.date
                          ? 'bg-accent/10 border-l-2 border-l-accent/60'
                          : selectedIdx === idx
                          ? 'bg-accent/10 border-l-2 border-l-accent'
                          : 'hover:bg-card-hover/60'
                      }`}
                    >
                      <td className="py-2 pr-2 font-mono">
                        <ParseEditCell
                          kind="plate"
                          value={o.plate}
                          readOnly={isDemo}
                          saving={isPlateLoading}
                          edited={o.plate_edited}
                          manual={o.manual_row}
                          emptyLabel="нет номера"
                          editTitle={o.plate ? 'Изменить гос.номер и перепроверить ТС в гео' : 'Вписать гос.номер вручную (OCR не распознал) и проверить в гео'}
                          editedTitle="Номер изменён оператором, перепроверено в гео"
                          onApply={val => handlePlateChange(o, val, idx)}
                        />
                      </td>
                      <td className="pr-2">
                        <ParseEditCell
                          kind="date"
                          value={o.date}
                          /* Без номера дату править нечему: строку сперва опознают. */
                          readOnly={isDemo || !o.plate}
                          saving={dateLoading.has(key)}
                          edited={o.date_edited}
                          emptyLabel="нет даты"
                          editTitle="Изменить дату неисправности и перепроверить в гео"
                          editedTitle="Дата изменена оператором, перепроверено в гео"
                          /* Год подставил разбор, а не клиент — см. YearFixedMark. */
                          suffix={<YearFixedMark on={yearFixedFor(res.parsed, o)} />}
                          onApply={val => handleDateChange(o, val, idx)}
                        />
                      </td>
                      <td className="pr-2">
                        <ParseEditCell
                          kind="number"
                          value={o.sheet_mileage_km != null ? String(o.sheet_mileage_km) : null}
                          readOnly={isDemo}
                          saving={mileageLoading.has(`${key}:sheet`)}
                          edited={o.mileage_edited}
                          emptyLabel="—"
                          editTitle={MILEAGE_FIELDS.sheet.editTitle}
                          editedTitle={MILEAGE_FIELDS.sheet.editedTitle}
                          suffix={<EngineHoursMark hours={o.engine_hours} />}
                          onApply={val => handleMileageChange(o, 'sheet', val, idx)}
                        />
                      </td>
                      <td className="pr-2">
                        <ParseEditCell
                          kind="number"
                          value={o.declared_system_km != null ? String(o.declared_system_km) : null}
                          readOnly={isDemo}
                          saving={mileageLoading.has(`${key}:declared`)}
                          edited={o.mileage_edited}
                          emptyLabel="—"
                          editTitle={MILEAGE_FIELDS.declared.editTitle}
                          editedTitle={MILEAGE_FIELDS.declared.editedTitle}
                          onApply={val => handleMileageChange(o, 'declared', val, idx)}
                        />
                      </td>
                      <td className="pr-2">{o.system_mileage_km ?? '—'}</td>
                      <td className="pr-2">
                        <VerdictCell
                          o={o}
                          readOnly={isDemo}
                          loading={isVerdictLoading}
                          onChange={v => handleVerdictChange(o, v, idx)}
                        />
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
                      {!isDemo && (
                        <td className="text-center">
                          <DeleteRowButton disabled={res.objects.length === 1} onClick={() => setDeleteIdx(idx)} />
                        </td>
                      )}
                    </tr>
                    {aiMiss[key] && (
                      <AiMissPrompt
                        issueId={issueId}
                        verdict={aiMiss[key]}
                        colSpan={PARSE_COLUMNS.length + (isDemo ? 2 : 3)}
                        onHide={() => setAiMiss(prev => { const n = { ...prev }; delete n[key]; return n })}
                      />
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <ParseDisagreeNote objects={res.objects} />
          <ParseTableNote />
          {!isDemo && (addOpen ? (
            <AddRowForm
              defaultDate={res.objects[0]?.date || todayIsoMsk()}
              onAdd={addRow}
              onCancel={() => setAddOpen(false)}
            />
          ) : (
            <AddRowButton onClick={() => setAddOpen(true)} />
          ))}
          {isAggregate && (
            /* Кнопки сводного ответа здесь НЕТ намеренно: оба источника ответа
               («по правилам» и «✦ ИИ») живут в липком баре, рядом с полем, куда
               текст и вставляется. Здесь — только пояснение про агрегатность. */
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
      {dateError && <p className="text-xs text-orange-400">{dateError}</p>}
      {mileageError && <p className="text-xs text-orange-400">{mileageError}</p>}
      {deleteIdx != null && res?.objects[deleteIdx] && (
        <DeleteRowDialog
          obj={res.objects[deleteIdx]}
          onConfirm={() => deleteRow(deleteIdx, res.objects[deleteIdx])}
          onCancel={() => setDeleteIdx(null)}
        />
      )}
      {rerunOpen && (
        <RerunConfirmDialog
          rows={manualEditedRows(res?.objects ?? [])}
          onConfirm={() => { setRerunOpen(false); startRun() }}
          onCancel={() => setRerunOpen(false)}
        />
      )}
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

function AiFeedbackPanel({ issueId, source, hasParse, objectCount }: {
  issueId: number
  /**
   * Источник вердикта выбранной строки: 'rules' — посчитали правила бесплатно,
   * 'ai' — отвечал DeepSeek, 'operator' — строку переписали руками. Раньше панель
   * ждала именно 'ai' и на бесплатном разборе кнопок не показывала — сообщить о
   * неверной дате или номере было НЕКУДА, хотя рождаются такие дефекты как раз в
   * правилах. Источник теперь едет в оценку: дефект правил лечится лестницей
   * вердиктов, промах модели — промптом.
   */
  source: VerdictSource | null
  /** Разбор есть (хотя бы одна строка) — без него оценивать действительно нечего. */
  hasParse: boolean
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

  const fbSource = source ?? 'rules'
  const saveGood = () => submit.mutate({ rating: 'good', verdict_source: fbSource })
  const saveBad = () =>
    submit.mutate({
      rating: 'bad',
      error_kind: errorKind,
      verdict_source: fbSource,
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
            {feedback.verdict_source && feedback.verdict_source !== 'ai' && (
              <span
                className="text-muted"
                title="Оценён разбор, посчитанный без модели — правилами или правкой оператора"
              >
                · {feedback.verdict_source === 'rules' ? 'правила' : 'правка оператора'}
              </span>
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
          повода. Без разбора оценивать нечего; в остальном оцениваем и бесплатный
          разбор по правилам — дефекты даты, номера и пробега родом оттуда. */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-[11px] leading-4 text-secondary">
          {!hasParse
            ? 'Разбора ещё нет — сначала разберите заявку'
            : source === 'ai'
              ? `ИИ разобрал ${objectCount} ${pluralObjects(objectCount)} — разбор верный?`
              : source === 'operator'
                ? 'Строку переписал оператор — оценка пойдёт как правка разбора'
                : `Разбор по правилам, ${objectCount} ${pluralObjects(objectCount)} — факты и вердикт верные?`}
        </span>
        {hasParse && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={saveGood}
              disabled={submit.isPending || isDemo}
              title={isDemo
                ? 'Недоступно в демо-режиме'
                : source === 'ai'
                  ? 'Разобрано верно — заявка уйдёт в тренировочные образцы как удачный пример'
                  : 'Разбор по правилам верный — оценка попадёт в «Оценки ИИ» с пометкой «правила»'}
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
              title={isDemo
                ? 'Недоступно в демо-режиме'
                : source === 'ai'
                  ? 'Ошибка разбора — указать, что именно ИИ понял неправильно'
                  : 'Ошибка разбора — указать, что именно правила поняли неправильно (дата, номер, пробег, вердикт)'}
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
            <span className="text-[10px] leading-4 text-muted">
              {source === 'ai'
                ? 'Оценка видна в разделе «Оценки ИИ» и идёт в few-shot'
                : 'Оценка видна в разделе «Оценки ИИ» с пометкой «правила» — это заявка на правку разбора, а не на дообучение модели'}
            </span>
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
  // Сводный ответ по всей заявке, написанный моделью (приходит тем же вызовом ИИ).
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  // `parsed.issue_intent` пакетного разбора: почему заявка вышла из пробеговой
  // лестницы. У одиночной берём из её собственного разбора (см. ниже).
  const [batchIntent, setBatchIntent] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<typeof ALL_STATUSES[number] | null>(null)
  const [resolveNotice, setResolveNotice] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Липкий бар v4: единственная точка составления ответа. Раскрывается по фокусу
  // на поле — тогда появляется второй ряд (черновик ИИ, публичный/приватный, «Ещё»).
  const [barExpanded, setBarExpanded] = useState(false)
  // Галочки «скопировано» в шапке (номер заявки и телефон контакта).
  const [numCopied, setNumCopied] = useState(false)
  const [phoneCopied, setPhoneCopied] = useState(false)
  // Поле ответа растёт под текст: фиксированные 84px показывали длинный ответ
  // тремя строками через скролл — оператор не видел, что именно отправляет.
  const replyRef = useRef<HTMLTextAreaElement>(null)
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

  // Авто-высота поля ответа: до 240px растём под текст, дальше скролл — иначе
  // раскрытый бар отъедал бы у карточки пол-экрана на длинном ответе.
  useEffect(() => {
    const el = replyRef.current
    if (!el) return
    if (!barExpanded) { el.style.height = ''; return }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [comment, barExpanded])

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
    setAiSummary(null)
    setBatchIntent(null)
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
  // Бесплатный разбор ЧИТАЕМ из кэша (enabled=false — своих запросов не шлём):
  // таблицу наполняет SingleParseTable, а карточке нужен только сводный ярлык
  // «про что заявка» для блока телеметрии.
  const { data: freeParseCached } = useFreeParse(selectedIssueId ?? 0, false)

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
  // Без типа Okdesk не пускает заявку ни в «В работе», ни в «Решена» (проверка в
  // кнопке «Ответить и решить» ниже). Тем же условием раскрываем «Детали заявки»:
  // тип правится там, и оператор видит блокер сразу, а не по тосту в конце.
  const typeMissing = !od?.type_code || od.type_code === 'inner'
  // Счётчик секции «Детали заявки»: тип и заполненность обязательной тройки
  // параметров — то, из-за чего заявка застревает. Видно, не разворачивая блок.
  // Считаем по сырым значениям Okdesk: витрина `parameters` подставляет телефон из
  // «Контактного лица» и счётчик показывал бы 3/3 у заявки с пустым атрибутом.
  const paramsFilled = od
    ? (od.editable_parameters
        ? od.editable_parameters.filter(p => p.value?.trim()).length
        : EDITABLE_PARAMS.filter(ep => od.parameters.some(p => ep.match.test(p.name) && p.value?.trim())).length)
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
  // Ярлык «про что заявка»: у пакетной приходит из её разбора, у одиночной — из
  // кэша `automate` либо бесплатного `parse`. Нет ярлыка — обычная заявка о пробеге.
  const issueIntent = batchIntent
    ?? freeParseCached?.parsed?.issue_intent
    ?? singleAnalysis?.parsed?.issue_intent
    ?? null
  // По служебному вердикту («не о пробеге», разбор не состоялся) готовый ответ
  // клиенту предлагать нельзя — чип «по правилам» для такой строки гасим.
  const selectedIsService = isServiceVerdict(selectedObj?.verdict)

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
          {od && <div className="mt-3"><OkdeskInfo d={od} issueId={issue.id} assigneeName={issue.assignee_name ?? null} subject={issue.subject ?? null} /></div>}

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
            onParse={(objects, meta) => {
              setParseRows(objects)
              setBatchAiNote(meta?.aiNote ?? null)
              setAiSummary(meta?.aiSummary ?? null)
              setBatchIntent(meta?.intent ?? null)
              // Строки обновились (прогон ИИ, правка номера/даты) — выбранный объект
              // должен показывать НОВЫЕ данные, а не копию до правки.
              setSelectedObj(prev => {
                if (selectedIdx != null && objects[selectedIdx]) return objects[selectedIdx]
                return prev
              })
            }}
          />
          <SingleParseTable
            issueId={issue.id}
            issueTitle={issue.subject}
            companyName={issue.company_name}
            onSelect={(obj, idx, objects) => { setSelectedIdx(idx); setSelectedObj(obj); setParseRows(objects) }}
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
            issueIntent={issueIntent}
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
              {/* Вердикт служебный: заявка не о пробеге — черновик как есть не шлём. */}
              {isNonMileageVerdict(selectedObj?.verdict) && (
                <div className="flex items-start gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-[11px] leading-4 text-warning">
                  <AlertTriangle size={13} className="mt-px shrink-0" /> {NON_MILEAGE_HINT}
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
          <AiFeedbackPanel
            issueId={issue.id}
            source={selectedSource}
            hasParse={parseRows.length > 0}
            objectCount={aiObjectCount}
          />
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
        {/* Раскрытый бар: поле ответа занимает ВСЮ ширину своей строкой, кнопки
            уезжают в ряд ниже. Раньше они стояли рядом с полем и отбирали у него
            треть ширины, а само поле было фиксированных 84px — длинный ответ
            читался через скролл в три строки. Теперь высота растёт под текст
            (до 240px), дальше скролл. */}
        <div className={`flex gap-2 ${barExpanded ? 'flex-col' : 'items-center'}`}>
          <textarea
            ref={replyRef}
            value={comment}
            onChange={e => setComment(e.target.value)}
            onFocus={() => setBarExpanded(true)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && comment) addComment.mutate(comment)
            }}
            rows={1}
            placeholder="Ответить клиенту…"
            title="Ctrl+Enter — отправить комментарий без смены статуса"
            className={`reply-field min-w-0 w-full bg-frame border border-border text-[13px] leading-5 text-white placeholder:text-muted px-3.5 py-2 resize-none outline-none focus:border-accent ${barExpanded ? 'min-h-[96px] rounded-xl' : 'h-9 rounded-pill'}`}
          />

          {!barExpanded && (
            <>
              <TemplatePicker trigger="text" onSelect={text => setComment(text)} issueId={issue.id} />
              <ResolveButton disabled={isDemo || typeMissing} isDemo={isDemo} typeMissing={typeMissing} onClick={() => openStatus('completed')} />
            </>
          )}
        </div>

        {barExpanded && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* Два ЯВНЫХ источника ответа вместо одного чипа «черновик ИИ»,
                    который отдавал то текст модели, то текст по правилам. */}
                <RulesAnswerChip
                  issueId={issue.id}
                  objectCount={parseRows.length}
                  selectedIdx={selectedIdx}
                  plate={selectedObj?.plate ?? null}
                  date={selectedObj?.date ?? null}
                  serviceVerdict={selectedIsService}
                  onUseDraft={text => { setComment(text); setCommentPublic(true) }}
                />
                <AiAnswerChip
                  draft={aiAnswered ? rowDraft : null}
                  summary={aiSummary}
                  plate={selectedObj?.plate ?? null}
                  onUseDraft={text => { setComment(text); setCommentPublic(true) }}
                />
                {/* Сегмент видимости: публичный ответ уходит клиенту */}
                <VisibilitySegments value={commentPublic} onChange={setCommentPublic} />
              </div>
              {/* Второстепенные действия — иконками: подписи «Ещё ▾» и «Свернуть»
                  отбирали ширину у поля ответа, а смысл читается из тултипа. */}
              <div className="flex shrink-0 items-center gap-1.5">
                <TemplatePicker trigger="text" onSelect={text => setComment(text)} issueId={issue.id} />
                <div className="relative">
                  <button
                    onClick={() => setMoreActionsOpen(v => !v)}
                    disabled={isDemo}
                    title={isDemo ? 'Недоступно в демо-режиме' : 'Другие действия: отправить комментарий без смены статуса, В работе, Ожидание ответа, Нет времени'}
                    className={`flex h-7 w-7 items-center justify-center rounded-pill bg-frame border border-border text-secondary hover:border-muted hover:text-white transition-colors disabled:opacity-40 ${isDemo ? 'cursor-not-allowed' : ''}`}
                  >
                    <MoreHorizontal size={14} />
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
                  className="flex h-7 w-7 items-center justify-center rounded-pill bg-frame border border-border text-secondary hover:border-muted hover:text-white transition-colors"
                >
                  <ChevronsDownUp size={14} />
                </button>
                <ResolveButton disabled={isDemo || typeMissing} isDemo={isDemo} typeMissing={typeMissing} onClick={() => openStatus('completed')} />
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
