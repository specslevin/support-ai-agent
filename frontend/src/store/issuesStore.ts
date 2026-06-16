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
  setFilter: (key: 'status' | 'company' | 'search' | 'assignee' | 'issueId', value: string) => void
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
      selectedIssueId: null,
      highlightId: null,
      trackOpen: false,
      trackPlate: null,
      trackDate: null,
      lastTemplate: '',
      checkedIds: [],
      batchChildren: {},

      setFilter: (key, value) => set({ [key]: value, page: 1, checkedIds: [] }),
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
      resetFilters: () => set({ status: '', company: '', search: '', assignee: '', issueId: '', page: 1 }),
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
    }),
    {
      name: 'issues-prefs',
      // Persist pagination size + last-used template across sessions.
      partialize: state => ({ limit: state.limit, lastTemplate: state.lastTemplate, batchChildren: state.batchChildren }),
    },
  ),
)
