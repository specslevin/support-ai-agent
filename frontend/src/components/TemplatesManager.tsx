import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  Plus, Search, Star, Trash2, Pencil, X, Check, Sparkles, FileText, Loader2,
} from 'lucide-react'
import { api } from '../api/client'
import type { Template, TemplateCreate } from '../types'
import { hasPlaceholders } from '../lib/templates'

const CATEGORY_COLORS: Record<string, string> = {
  primary: 'text-blue-400',
  secondary: 'text-gray-400',
  success: 'text-green-400',
  danger: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-cyan-400',
  dark: 'text-gray-500',
}

const DYN_HINT = 'Используйте [плейсхолдеры] в тексте — при вставке шаблон запросит их значения.'

type FormState = {
  id: number | null
  name: string
  content: string
  category_id: number | null
  is_dynamic: boolean
  is_favorite: boolean
}

const EMPTY_FORM: FormState = {
  id: null, name: '', content: '', category_id: null, is_dynamic: false, is_favorite: false,
}

function TemplateForm({
  initial,
  onClose,
}: {
  initial: FormState
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(initial)

  const { data: categories = [] } = useQuery({
    queryKey: ['template-categories'],
    queryFn: () => api.listTemplateCategories(),
    staleTime: 5 * 60_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['templates'] })
  }

  const createMut = useMutation({
    mutationFn: (body: TemplateCreate) => api.createTemplate(body),
    onSuccess: () => { invalidate(); onClose() },
  })

  const updateMut = useMutation({
    mutationFn: () => api.updateTemplate(form.id!, {
      name: form.name,
      content: form.content,
      category_id: form.category_id,
      is_dynamic: form.is_dynamic,
      is_favorite: form.is_favorite,
    }),
    onSuccess: () => { invalidate(); onClose() },
  })

  const isEdit = form.id != null
  const pending = createMut.isPending || updateMut.isPending
  const isError = createMut.isError || updateMut.isError
  const canSubmit = form.name.trim() && form.content.trim() && !pending

  // Auto-suggest dynamic when placeholders are present (non-blocking hint).
  const looksDynamic = form.is_dynamic || hasPlaceholders(form.content)

  const submit = () => {
    if (!canSubmit) return
    if (isEdit) {
      updateMut.mutate()
    } else {
      createMut.mutate({
        name: form.name.trim(),
        content: form.content,
        category_id: form.category_id ?? undefined,
        is_dynamic: form.is_dynamic,
        is_favorite: form.is_favorite,
      })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-lg z-10">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-semibold flex items-center gap-1.5">
            <FileText size={14} className="text-accent" />
            {isEdit ? 'Редактировать шаблон' : 'Новый шаблон'}
          </span>
          <button onClick={onClose} className="text-muted hover:text-white"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
          <div>
            <label className="block text-[11px] text-muted mb-1">Название</label>
            <input
              autoFocus
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full bg-frame border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-[11px] text-muted mb-1">Текст</label>
            <textarea
              rows={6}
              value={form.content}
              onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              className="w-full bg-frame border border-border rounded-lg px-3 py-2 text-xs resize-y focus:outline-none focus:border-accent leading-relaxed"
            />
            {looksDynamic && (
              <p className="flex items-start gap-1.5 text-[10px] text-accent mt-1">
                <Sparkles size={11} className="shrink-0 mt-0.5" /> {DYN_HINT}
              </p>
            )}
          </div>

          <div>
            <label className="block text-[11px] text-muted mb-1">Категория</label>
            <select
              value={form.category_id ?? ''}
              onChange={e => setForm(f => ({ ...f, category_id: e.target.value ? Number(e.target.value) : null }))}
              className="w-full bg-frame border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
            >
              <option value="">Без категории</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.is_dynamic}
                onChange={e => setForm(f => ({ ...f, is_dynamic: e.target.checked }))}
                className="w-3.5 h-3.5 accent-accent"
              />
              <span className="text-xs text-muted">Динамический</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.is_favorite}
                onChange={e => setForm(f => ({ ...f, is_favorite: e.target.checked }))}
                className="w-3.5 h-3.5 accent-accent"
              />
              <span className="text-xs text-muted">Избранное</span>
            </label>
          </div>

          {isError && <p className="text-xs text-orange-400">Ошибка сохранения. Попробуйте снова.</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-muted hover:text-white rounded-lg">Отмена</button>
          <button
            disabled={!canSubmit}
            onClick={submit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-black rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

export function TemplatesManager() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.listTemplates(),
    staleTime: 60_000,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['templates'] })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteTemplate(id),
    onSuccess: () => { invalidate(); setConfirmDelete(null) },
  })

  const favMut = useMutation({
    mutationFn: ({ id, value }: { id: number; value: boolean }) =>
      api.updateTemplate(id, { is_favorite: value }),
    onSuccess: invalidate,
  })

  const grouped = useMemo(() => {
    const filtered = search
      ? templates.filter(t =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          t.content.toLowerCase().includes(search.toLowerCase()))
      : templates
    const byCat = filtered.reduce<Record<string, Template[]>>((acc, t) => {
      const key = t.category_name ?? 'Без категории'
      ;(acc[key] ??= []).push(t)
      return acc
    }, {})
    for (const items of Object.values(byCat)) {
      items.sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || b.usage_count - a.usage_count)
    }
    return Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b))
  }, [templates, search])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <FileText size={18} className="text-accent" /> Шаблоны ответов
          </h2>
          <span className="text-xs text-muted">{templates.length}</span>
          <button
            onClick={() => setForm({ ...EMPTY_FORM })}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-black rounded-lg hover:opacity-90 transition-opacity"
          >
            <Plus size={14} /> Создать шаблон
          </button>
        </div>

        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Поиск по названию или тексту..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-frame border border-border rounded-lg pl-9 pr-3 py-2 text-xs focus:outline-none focus:border-accent"
          />
        </div>

        {isLoading && (
          <p className="flex items-center gap-2 text-xs text-muted"><Loader2 size={14} className="animate-spin" /> Загрузка…</p>
        )}
        {!isLoading && grouped.length === 0 && (
          <p className="text-xs text-muted py-6 text-center">Шаблоны не найдены</p>
        )}

        <div className="space-y-5">
          {grouped.map(([cat, items]) => {
            const color = CATEGORY_COLORS[items[0]?.category_color ?? ''] ?? 'text-gray-400'
            return (
              <div key={cat} className="space-y-2">
                <div className={`text-[10px] uppercase tracking-widest font-semibold ${color}`}>{cat}</div>
                {items.map(t => {
                  const isDyn = t.is_dynamic || hasPlaceholders(t.content)
                  return (
                    <div key={t.id} className="bg-card border border-border rounded-lg px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => favMut.mutate({ id: t.id, value: !t.is_favorite })}
                          title={t.is_favorite ? 'Убрать из избранного' : 'В избранное'}
                          className="shrink-0 text-muted hover:text-warning transition-colors"
                        >
                          <Star size={14} className={t.is_favorite ? 'text-warning fill-warning' : ''} />
                        </button>
                        <span className="text-xs text-white font-medium flex-1 truncate">{t.name}</span>
                        {isDyn && (
                          <span
                            title="Динамический шаблон — запросит значения плейсхолдеров"
                            className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wide text-accent bg-accent/10 border border-accent/30 rounded px-1 py-px"
                          >
                            <Sparkles size={9} /> дин.
                          </span>
                        )}
                        {t.usage_count > 0 && <span className="text-[10px] text-muted shrink-0">{t.usage_count}</span>}
                        <button
                          onClick={() => setForm({
                            id: t.id, name: t.name, content: t.content,
                            category_id: t.category_id ?? null,
                            is_dynamic: t.is_dynamic, is_favorite: t.is_favorite,
                          })}
                          title="Редактировать"
                          className="shrink-0 text-muted hover:text-accent transition-colors"
                        >
                          <Pencil size={13} />
                        </button>
                        {confirmDelete === t.id ? (
                          <span className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => deleteMut.mutate(t.id)}
                              disabled={deleteMut.isPending}
                              className="text-[10px] text-orange-400 hover:underline"
                            >
                              Удалить?
                            </button>
                            <button onClick={() => setConfirmDelete(null)} className="text-muted hover:text-white"><X size={12} /></button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(t.id)}
                            title="Удалить"
                            className="shrink-0 text-muted hover:text-orange-400 transition-colors"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted line-clamp-2 leading-relaxed whitespace-pre-wrap">{t.content}</p>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {form && <TemplateForm initial={form} onClose={() => setForm(null)} />}
    </div>
  )
}
