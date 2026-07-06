import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Bookmark, ChevronDown, Plus, Pencil, Trash2, Check, X, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import type { SavedFilter, SavedFilterValues } from '../types'

// Собрать текущие условия фильтра из стора в тело сохранённого фильтра.
function useCurrentFilters(): SavedFilterValues {
  const { status, company, search, assignee, issueId, sort, order } = useIssuesStore()
  return { status, company, search, assignee, issueId, sort, order }
}

// Нормализация для сравнения: пустые строки/undefined эквивалентны, у sort/order — дефолты.
function normFilters(f: Partial<SavedFilterValues>) {
  return {
    status: f.status || '',
    company: f.company || '',
    search: f.search || '',
    assignee: f.assignee || '',
    issueId: f.issueId || '',
    sort: f.sort || 'deadline_at',
    order: f.order || 'asc',
  }
}

function sameFilters(a: Partial<SavedFilterValues>, b: Partial<SavedFilterValues>): boolean {
  const na = normFilters(a), nb = normFilters(b)
  return (Object.keys(na) as (keyof typeof na)[]).every(k => na[k] === nb[k])
}

export function SavedFilters() {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const queryClient = useQueryClient()
  const applyFilters = useIssuesStore(s => s.applyFilters)
  const current = useCurrentFilters()

  const { data: filters = [] } = useQuery({
    queryKey: ['saved-filters'],
    queryFn: () => api.listSavedFilters(),
    staleTime: 60_000,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['saved-filters'] })

  // Какой сохранённый фильтр совпадает с текущими условиями (подсветка «активен»).
  const activeFilter = filters.find(f => sameFilters(f.filters, current)) || null

  const createMut = useMutation({
    mutationFn: (name: string) => api.createSavedFilter({ name, filters: current }),
    onSuccess: () => { invalidate(); setCreating(false); setNewName('') },
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.updateSavedFilter(id, { name }),
    onSuccess: () => { invalidate(); setEditId(null); setEditName('') },
  })

  // «Обновить текущими условиями» — перезаписать filters пресета активным фильтром.
  const overwriteMut = useMutation({
    mutationFn: (id: number) => api.updateSavedFilter(id, { filters: current }),
    onSuccess: () => invalidate(),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteSavedFilter(id),
    onSuccess: () => invalidate(),
  })

  const apply = (f: SavedFilter, close: () => void) => {
    applyFilters(f.filters)
    close()
  }

  const close = () => {
    setOpen(false)
    setCreating(false)
    setNewName('')
    setEditId(null)
    setEditName('')
  }

  const startCreate = () => {
    setCreating(true)
    setNewName('')
    setEditId(null)
  }

  const btnCls = `flex items-center gap-1 text-sm px-3 py-1.5 rounded border transition-colors max-w-[220px] ${
    activeFilter ? 'border-accent text-accent bg-accent/10' : 'border-border text-white hover:border-accent'
  }`

  return (
    <div className="relative">
      <button onClick={() => (open ? close() : setOpen(true))} className={btnCls} title={activeFilter ? `Активен: ${activeFilter.name}` : 'Мои фильтры'}>
        <Bookmark size={14} className={activeFilter ? 'text-accent' : 'text-muted'} />
        <span className="truncate">{activeFilter ? activeFilter.name : 'Мои фильтры'}</span>
        <ChevronDown size={13} className={activeFilter ? 'text-accent' : 'text-muted'} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute left-0 top-full mt-1 z-50 bg-card border border-border rounded-lg py-1 min-w-[260px] max-h-[70vh] overflow-y-auto shadow-lg">
            {filters.length === 0 && !creating && (
              <div className="px-3 py-2 text-xs text-muted">Пока нет сохранённых фильтров</div>
            )}

            {filters.map(f => (
              <div
                key={f.id}
                className={`group flex items-center gap-1 px-2 py-1.5 hover:bg-surface ${activeFilter?.id === f.id ? 'bg-accent/10' : ''}`}
              >
                {editId === f.id ? (
                  <>
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && editName.trim()) renameMut.mutate({ id: f.id, name: editName.trim() })
                        if (e.key === 'Escape') { setEditId(null); setEditName('') }
                      }}
                      className="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-accent"
                    />
                    <button
                      title="Сохранить имя"
                      disabled={!editName.trim() || renameMut.isPending}
                      onClick={() => renameMut.mutate({ id: f.id, name: editName.trim() })}
                      className="p-1 text-success hover:text-white disabled:opacity-40"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      title="Отмена"
                      onClick={() => { setEditId(null); setEditName('') }}
                      className="p-1 text-muted hover:text-white"
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => apply(f, close)}
                      className={`flex-1 min-w-0 flex items-center gap-1.5 text-left text-sm truncate ${activeFilter?.id === f.id ? 'text-accent font-medium' : 'text-white'}`}
                      title={activeFilter?.id === f.id ? `Активен: ${f.name}` : `Применить: ${f.name}`}
                    >
                      {activeFilter?.id === f.id && <Check size={13} className="shrink-0 text-accent" />}
                      <span className="truncate">{f.name}</span>
                    </button>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        title="Обновить текущими условиями"
                        disabled={overwriteMut.isPending}
                        onClick={() => overwriteMut.mutate(f.id)}
                        className="p-1 text-muted hover:text-accent disabled:opacity-40"
                      >
                        <RefreshCw size={13} />
                      </button>
                      <button
                        title="Переименовать"
                        onClick={() => { setEditId(f.id); setEditName(f.name); setCreating(false) }}
                        className="p-1 text-muted hover:text-white"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        title="Удалить"
                        disabled={deleteMut.isPending}
                        onClick={() => {
                          if (window.confirm(`Удалить фильтр «${f.name}»?`)) deleteMut.mutate(f.id)
                        }}
                        className="p-1 text-muted hover:text-red-400 disabled:opacity-40"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}

            <div className="border-t border-border mt-1 pt-1 px-2">
              {creating ? (
                <div className="flex items-center gap-1 py-1">
                  <input
                    autoFocus
                    placeholder="Название фильтра"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newName.trim()) createMut.mutate(newName.trim())
                      if (e.key === 'Escape') { setCreating(false); setNewName('') }
                    }}
                    className="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 text-sm text-white placeholder-muted focus:outline-none focus:border-accent"
                  />
                  <button
                    title="Сохранить"
                    disabled={!newName.trim() || createMut.isPending}
                    onClick={() => createMut.mutate(newName.trim())}
                    className="p-1 text-success hover:text-white disabled:opacity-40"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    title="Отмена"
                    onClick={() => { setCreating(false); setNewName('') }}
                    className="p-1 text-muted hover:text-white"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={startCreate}
                  className="flex items-center gap-1.5 w-full text-left text-sm text-muted hover:text-white py-1.5 transition-colors"
                >
                  <Plus size={14} />
                  Сохранить текущий
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
