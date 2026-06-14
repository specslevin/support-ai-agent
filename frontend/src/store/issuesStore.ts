import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface FiltersState {
  status: string
  company: string
  search: string
  page: number
  limit: number
  selectedIssueId: number | null
  setFilter: (key: 'status' | 'company' | 'search', value: string) => void
  setPage: (page: number) => void
  setLimit: (limit: number) => void
  selectIssue: (id: number | null) => void
  resetFilters: () => void
}

export const useIssuesStore = create<FiltersState>()(
  persist(
    set => ({
      status: '',
      company: '',
      search: '',
      page: 1,
      limit: 20,
      selectedIssueId: null,

      setFilter: (key, value) => set({ [key]: value, page: 1 }),
      setPage: page => set({ page }),
      setLimit: limit => set({ limit, page: 1 }),
      selectIssue: id => set({ selectedIssueId: id }),
      resetFilters: () => set({ status: '', company: '', search: '', page: 1 }),
    }),
    {
      name: 'issues-prefs',
      // Persist only the pagination size — the rest stays per-session.
      partialize: state => ({ limit: state.limit }),
    },
  ),
)
