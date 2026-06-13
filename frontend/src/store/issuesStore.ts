import { create } from 'zustand'

interface FiltersState {
  status: string
  company: string
  search: string
  page: number
  limit: number
  selectedIssueId: number | null
  setFilter: (key: 'status' | 'company' | 'search', value: string) => void
  setPage: (page: number) => void
  selectIssue: (id: number | null) => void
  resetFilters: () => void
}

export const useIssuesStore = create<FiltersState>(set => ({
  status: '',
  company: '',
  search: '',
  page: 1,
  limit: 20,
  selectedIssueId: null,

  setFilter: (key, value) => set({ [key]: value, page: 1 }),
  setPage: page => set({ page }),
  selectIssue: id => set({ selectedIssueId: id }),
  resetFilters: () => set({ status: '', company: '', search: '', page: 1 }),
}))
