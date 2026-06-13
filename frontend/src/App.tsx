import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { IssueFilters } from './components/IssueFilters'
import { IssuesList } from './components/IssuesList'
import { IssueDetail } from './components/IssueDetail'
import { useIssuesStore } from './store/issuesStore'
import { api } from './api/client'

const queryClient = new QueryClient()

function Dashboard() {
  const selectedIssueId = useIssuesStore(s => s.selectedIssueId)
  const [refreshing, setRefreshing] = useState(false)
  const [lastSynced, setLastSynced] = useState<number | null>(null)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const result = await api.refreshCache()
      setLastSynced(result.synced)
      queryClient.invalidateQueries({ queryKey: ['issues'] })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-base text-white">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-accent font-bold text-sm tracking-tight">GPSPOS</span>
          <span className="text-muted text-xs">/ Заявки</span>
        </div>
        <div className="flex items-center gap-3">
          {lastSynced != null && (
            <span className="text-xs text-muted">Синхронизировано: {lastSynced}</span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent transition-colors disabled:opacity-40"
          >
            {refreshing ? 'Синхронизация...' : '↻ Обновить кэш'}
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="px-6 py-3 border-b border-border shrink-0">
        <IssueFilters />
      </div>

      {/* Content */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex flex-col transition-all ${selectedIssueId ? 'w-3/5' : 'w-full'} border-r border-border min-h-0`}>
          <IssuesList />
        </div>
        {selectedIssueId && (
          <div className="w-2/5 flex flex-col min-h-0 overflow-hidden">
            <IssueDetail />
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  )
}
