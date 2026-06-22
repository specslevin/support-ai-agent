import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { RefreshCw, ClipboardList, MessageSquare, Phone, Truck, BarChart3, Settings, LogOut, UserCircle, type LucideIcon } from 'lucide-react'
import { IssueFilters } from './components/IssueFilters'
import { IssuesList, useViewMode } from './components/IssuesList'
import { IssueDetail } from './components/IssueDetail'
import { TrackPanel } from './components/TrackPanel'
import { ChatPanel } from './components/ChatPanel'
import { Sidebar, type Section } from './components/Sidebar'
import { StubSection } from './components/StubSection'
import { TemplatesManager } from './components/TemplatesManager'
import { Login } from './components/Login'
import { DemoBanner } from './components/DemoBanner'
import { DemoToast } from './components/DemoToast'
import { useIssuesStore } from './store/issuesStore'
import { useAuthStore } from './store/authStore'
import { api, authApi } from './api/client'

const queryClient = new QueryClient()


function UserIndicator() {
  const user = useAuthStore(s => s.user)
  if (!user) return null

  const isAdmin = user.role === 'admin'
  const badgeClass = isAdmin
    ? 'bg-accent/15 text-accent'
    : 'bg-warning/15 text-warning'
  const badgeLabel = isAdmin ? 'админ' : 'просмотр'

  return (
    <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border bg-card text-white">
      <UserCircle size={14} className="text-muted shrink-0" />
      <span className="font-medium">{user.username}</span>
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none ${badgeClass}`}>
        {badgeLabel}
      </span>
    </div>
  )
}

function LogoutButton() {
  const logout = useAuthStore(s => s.logout)
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted">Выйти?</span>
        <button
          onClick={() => { logout() }}
          className="text-xs px-2 py-1 rounded border border-orange-500/50 text-orange-400 hover:border-orange-500 transition-colors"
        >
          Да
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs px-2 py-1 rounded border border-border text-muted hover:text-white transition-colors"
        >
          Нет
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title="Выйти"
      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:border-orange-500/50 hover:text-orange-400 text-muted transition-colors"
    >
      <LogOut size={13} />
      Выйти
    </button>
  )
}

function Dashboard() {
  const selectedIssueId = useIssuesStore(s => s.selectedIssueId)
  const trackOpen = useIssuesStore(s => s.trackOpen)
  const [section, setSection] = useState<Section>('issues')
  const [refreshing, setRefreshing] = useState(false)
  const [lastSynced, setLastSynced] = useState<number | null>(null)
  const user = useAuthStore(s => s.user)
  const isDemo = user?.role === 'demo'
  const [viewMode, setViewMode] = useViewMode()

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
        {/* Демо-баннер */}
        {isDemo && <DemoBanner />}

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
            <UserIndicator />
            <LogoutButton />
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

            {/* Track + charts panel — same overlay as the issues branch */}
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
        ) : isIssues ? (
          <>
            {/* Filters */}
            <div className="px-6 py-3 border-b border-border shrink-0">
              <IssueFilters viewMode={viewMode} onViewModeChange={setViewMode} />
            </div>

            {/* Content */}
            <div className="flex flex-1 min-h-0 relative">
              <div className={`flex flex-col transition-all ${selectedIssueId ? 'w-3/5' : 'w-full'} border-r border-border min-h-0`}>
                <IssuesList viewMode={viewMode} onViewModeChange={setViewMode} />
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
        ) : section === 'settings' ? (
          <TemplatesManager />
        ) : (
          <StubSection section={section as Exclude<Section, 'issues' | 'chat' | 'settings'>} />
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

function AuthGate() {
  const { token, user, setAuth, logout } = useAuthStore()
  const [validating, setValidating] = useState(true)

  // On mount: if we have a stored token, validate it with /auth/me
  useEffect(() => {
    if (!token) {
      setValidating(false)
      return
    }
    authApi.getMe()
      .then((me) => {
        // Refresh user info (role may have changed)
        setAuth(token, me)
        setValidating(false)
      })
      .catch(() => {
        logout()
        setValidating(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen for auth:logout events dispatched by the axios interceptor
  useEffect(() => {
    const handler = () => logout()
    window.addEventListener('auth:logout', handler)
    return () => window.removeEventListener('auth:logout', handler)
  }, [logout])

  if (validating) {
    // Minimal loading state while validating stored token
    return (
      <div className="flex h-screen bg-base items-center justify-center">
        <span className="text-sm text-muted animate-pulse">Проверка сессии...</span>
      </div>
    )
  }

  if (!token || !user) {
    return <Login />
  }

  return <Dashboard />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate />
      <DemoToast />
    </QueryClientProvider>
  )
}
