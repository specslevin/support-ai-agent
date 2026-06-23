import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ChildInfo { issue_id?: number; ok: boolean }

interface FiltersState {
  status: string
  company: string
  search: string
  assignee: string
  issueId: string
  page: number
  limit: number
  sort: string
  order: 'asc' | 'desc'
  selectedIssueId: number | null
  highlightId: number | null
  trackOpen: boolean
  trackPlate: string | null
  trackDate: string | null
  lastTemplate: string
  checkedIds: number[]
  // Per-issue created child issues: issueId → plate → { issue_id, ok }
  // Lives in session memory only (not persisted); survives panel close/reopen.
  batchChildren: Record<number, Record<string, ChildInfo>>
  lastBatchTemplate: { name: string; content: string } | null
  setFilter: (key: 'status' | 'company' | 'search' | 'assignee' | 'issueId', value: string) => void
  setSort: (sort: string, order: 'asc' | 'desc') => void
  setPage: (page: number) => void
  setLimit: (limit: number) => void
  selectIssue: (id: number | null) => void
  setTrackOpen: (open: boolean) => void
  openTrack: (plate?: string | null, date?: string | null) => void
  setLastTemplate: (content: string) => void
  toggleChecked: (id: number) => void
  setChecked: (ids: number[]) => void
  clearChecked: () => void
  resetFilters: () => void
  setBatchChild: (issueId: number, plate: string, info: ChildInfo) => void
  clearBatchChildren: (issueId: number) => void
  setLastBatchTemplate: (t: { name: string; content: string } | null) => void
}

export const useIssuesStore = create<FiltersState>()(
  persist(
    set => ({
      status: '',
      company: '',
      search: '',
      assignee: '',
      issueId: '',
      page: 1,
      limit: 20,
      sort: 'deadline_at',
      order: 'asc' as const,
      selectedIssueId: null,
      highlightId: null,
      trackOpen: false,
      trackPlate: null,
      trackDate: null,
      lastTemplate: '',
      checkedIds: [],
      batchChildren: {},
      lastBatchTemplate: null,

      setFilter: (key, value) => set({ [key]: value, page: 1, checkedIds: [] }),
      setSort: (sort, order) => set({ sort, order, page: 1 }),
      setPage: page => set({ page, checkedIds: [] }),
      setLimit: limit => set({ limit, page: 1, checkedIds: [] }),
      toggleChecked: id => set(state => ({
        checkedIds: state.checkedIds.includes(id)
          ? state.checkedIds.filter(x => x !== id)
          : [...state.checkedIds, id],
      })),
      setChecked: ids => set({ checkedIds: ids }),
      clearChecked: () => set({ checkedIds: [] }),
      // Keep the row highlighted after the detail panel is closed (id=null),
      // until another issue is opened.
      selectIssue: id => set(state => ({
        selectedIssueId: id,
        highlightId: id ?? state.highlightId,
        trackOpen: false,
        trackPlate: null,
        trackDate: null,
      })),
      setTrackOpen: open => set({ trackOpen: open }),
      openTrack: (plate = null, date = null) => set({ trackOpen: true, trackPlate: plate, trackDate: date }),
      setLastTemplate: content => set({ lastTemplate: content }),
      resetFilters: () => set({ status: '', company: '', search: '', assignee: '', issueId: '', page: 1, sort: 'deadline_at', order: 'asc' }),
      setBatchChild: (issueId, plate, info) => set(state => ({
        batchChildren: {
          ...state.batchChildren,
          [issueId]: { ...state.batchChildren[issueId], [plate]: info },
        },
      })),
      clearBatchChildren: issueId => set(state => {
        const next = { ...state.batchChildren }
        delete next[issueId]
        return { batchChildren: next }
      }),
      setLastBatchTemplate: t => set({ lastBatchTemplate: t }),
    }),
    {
      name: 'issues-prefs',
      // Persist pagination size + last-used template + filter combo across sessions.
      // Filters (status/company/assignee/search/issueId) are remembered so a
      // frequently-used combo survives reloads. `page` is intentionally NOT
      // persisted (always start on page 1); transient UI state is excluded too.
      partialize: state => ({
        status: state.status,
        company: state.company,
        assignee: state.assignee,
        search: state.search,
        issueId: state.issueId,
        limit: state.limit,
        sort: state.sort,
        order: state.order,
        lastTemplate: state.lastTemplate,
        batchChildren: state.batchChildren,
        lastBatchTemplate: state.lastBatchTemplate,
      }),
    },
  ),
)
