import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { ChevronDown, RefreshCw, ClipboardList, MessageSquare, Phone, Truck, BarChart3, Settings, type LucideIcon } from 'lucide-react'
import { IssueFilters } from './components/IssueFilters'
import { IssuesList } from './components/IssuesList'
import { IssueDetail } from './components/IssueDetail'
import { TrackPanel } from './components/TrackPanel'
import { ChatPanel } from './components/ChatPanel'
import { Sidebar, type Section } from './components/Sidebar'
import { StubSection } from './components/StubSection'
import { EmployeeMenu } from './components/pickers'
import { useIssuesStore } from './store/issuesStore'
import { useUserStore } from './store/userStore'
import { api } from './api/client'

const queryClient = new QueryClient()

function UserSelector() {
  const { currentUser, setCurrentUser } = useUserStore()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-border hover:border-accent transition-colors"
      >
        <span className="text-muted">Я:</span>
        <span className={currentUser ? 'text-white' : 'text-muted/60'}>
          {currentUser?.name ?? 'Выбрать...'}
        </span>
        <ChevronDown size={13} className="text-muted" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg py-1 z-50 w-44 shadow-lg">
          <EmployeeMenu
            selectedId={currentUser?.id ?? null}
            onPick={emp => { setCurrentUser(emp); setOpen(false) }}
          />
          {currentUser && (
            <>
              <div className="border-t border-border my-1" />
              <button
                onClick={() => { setCurrentUser(null); setOpen(false) }}
                className="w-full text-left px-4 py-1.5 text-xs text-muted hover:text-white hover:bg-white/5 transition-colors"
              >
                Не выбрано
              </button>
            </>
          )}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      )}
    </div>
  )
}

function Dashboard() {
  const selectedIssueId = useIssuesStore(s => s.selectedIssueId)
  const trackOpen = useIssuesStore(s => s.trackOpen)
  const [section, setSection] = useState<Section>('issues')
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

  const isIssues = section === 'issues'

  return (
    <div className="flex h-screen bg-base text-white">
      {/* Сайдбар (свёрнут по умолчанию) */}
      <Sidebar active={section} onSelect={setSection} />

      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar / header */}
        <header className="flex items-center justify-between px-6 h-14 border-b border-border shrink-0 bg-darker">
          <div className="flex items-center gap-2.5">
            {(() => { const HI = SECTION_ICON[section]; return <HI size={18} className="text-accent shrink-0" /> })()}
            <h1 className="text-sm font-bold text-white">{sectionTitle(section)}</h1>
          </div>
          <div className="flex items-center gap-3">
            {isIssues && lastSynced != null && (
              <span className="text-xs text-muted">Синхронизировано: {lastSynced}</span>
            )}
            <UserSelector />
            {isIssues && (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-border hover:border-accent transition-colors disabled:opacity-40"
              >
                <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
                {refreshing ? 'Синхронизация...' : 'Обновить кэш'}
              </button>
            )}
          </div>
        </header>

        {section === 'chat' ? (
          <div className="flex flex-1 min-h-0 relative">
            <div className={`flex flex-col transition-all ${selectedIssueId ? 'w-3/5' : 'w-full'} min-h-0`}>
              <ChatPanel />
            </div>
            {selectedIssueId && (
              <div className="w-2/5 flex flex-col min-h-0 overflow-hidden border-l border-border">
                <IssueDetail />
              </div>
            )}
          </div>
        ) : isIssues ? (
          <>
            {/* Filters */}
            <div className="px-6 py-3 border-b border-border shrink-0">
              <IssueFilters />
            </div>

            {/* Content */}
            <div className="flex flex-1 min-h-0 relative">
              <div className={`flex flex-col transition-all ${selectedIssueId ? 'w-3/5' : 'w-full'} border-r border-border min-h-0`}>
                <IssuesList />
              </div>
              {selectedIssueId && (
                <div className="w-2/5 flex flex-col min-h-0 overflow-hidden">
                  <IssueDetail />
                </div>
              )}

              {/* Track + charts panel — slides out to the left of the detail drawer */}
              {selectedIssueId && (
                <div
                  className={`absolute top-0 bottom-0 right-[40%] bg-base border-r border-border z-30 flex flex-col min-h-0 shadow-2xl transition-all duration-300 ${
                    trackOpen ? 'left-0 opacity-100' : 'left-[40%] opacity-0 pointer-events-none'
                  }`}
                >
                  {trackOpen && <TrackPanel issueId={selectedIssueId} />}
                </div>
              )}
            </div>
          </>
        ) : (
          <StubSection section={section as Exclude<Section, 'issues' | 'chat'>} />
        )}
      </div>
    </div>
  )
}

const SECTION_ICON: Record<Section, LucideIcon> = {
  issues: ClipboardList, chat: MessageSquare, mango: Phone, installers: Truck, analytics: BarChart3, settings: Settings,
}

function sectionTitle(s: Section): string {
  const map: Record<Section, string> = {
    issues: 'Заявки',
    chat: 'ИИ-чат',
    mango: 'Mango — звонки',
    installers: 'Выезды монтажников',
    analytics: 'Аналитика',
    settings: 'Настройки',
  }
  return map[s]
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  )
}
