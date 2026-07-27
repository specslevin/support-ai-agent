import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { RefreshCw, ClipboardList, MessageSquare, Phone, Truck, BarChart3, Settings, ThumbsUp, LogOut, UserCircle, type LucideIcon } from 'lucide-react'
import { IssueFilters } from './components/IssueFilters'
import { IssuesList, useViewMode } from './components/IssuesList'
import { IssueDetail } from './components/IssueDetail'
import { TrackPanel } from './components/TrackPanel'
import { ChatPanel } from './components/ChatPanel'
import { Sidebar, type Section } from './components/Sidebar'
import { StubSection } from './components/StubSection'
import { TemplatesManager } from './components/TemplatesManager'
import { AiFeedbackReview } from './components/AiFeedbackReview'
import { Login } from './components/Login'
import { DemoBanner } from './components/DemoBanner'
import { DemoToast } from './components/DemoToast'
import { useIssuesStore } from './store/issuesStore'
import { useAuthStore } from './store/authStore'
import { api, authApi } from './api/client'

const queryClient = new QueryClient()

/** Ширина рельсы карточки заявки (макет v4). Единственное место с этим числом —
 *  и в ветке «Заявки», и в ветке «ИИ-чат» карточка всегда ровно такая. */
const RAIL_W = 'w-[680px]'

/** Порог, ниже которого при открытом треке левая панель (список/чат) скрывается:
 *  треку нужно ≥520px, рельсе — 680px, вместе это уже 1200px. */
const WIDE = 'min-[1600px]:flex'

/** Трек + графики. Не оверлей, а обычный flex-сосед СЛЕВА от рельсы карточки.
 *  Одна и та же разметка для обеих веток («Заявки» и «ИИ-чат»). Закрытая панель
 *  не рендерится вообще; появление анимирует .track-slide (transform+opacity). */
function TrackSlot({ issueId, open }: { issueId: number | null; open: boolean }) {
  if (!open || issueId == null) return null
  return (
    <div className="flex-1 min-w-[520px] min-h-0 overflow-hidden bg-base">
      <div className="track-slide h-full flex flex-col min-h-0">
        <TrackPanel issueId={issueId} />
      </div>
    </div>
  )
}

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
  const detailExpanded = useIssuesStore(s => s.detailExpanded)
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
          /* Порядок слева-направо: [чат] [трек] [карточка 680] */
          <div className="flex flex-1 min-h-0">
            <div className={`flex-col min-h-0 flex-1 min-w-0 ${
              trackOpen && selectedIssueId
                ? `hidden ${WIDE}`
                : detailExpanded && selectedIssueId ? 'hidden' : 'flex'
            }`}>
              <ChatPanel />
            </div>

            <TrackSlot issueId={selectedIssueId} open={trackOpen} />

            {selectedIssueId && (
              <div className={`${RAIL_W} shrink-0 border-l border-border flex flex-col min-h-0 overflow-hidden`}>
                <IssueDetail />
              </div>
            )}
          </div>
        ) : isIssues ? (
          <>
            {/* Filters */}
            <div className="px-6 py-3 border-b border-border shrink-0">
              <IssueFilters viewMode={viewMode} onViewModeChange={setViewMode} />
            </div>

            {/* Content — порядок слева-направо: [список] [трек] [карточка 680] */}
            <div className="flex flex-1 min-h-0">
              {/* Список: тянется по остатку ширины; при открытом треке ужимается
                  до узкой полосы (номер + тема + статус читаются), а на окне
                  меньше 1600px уходит совсем — треку и рельсе нужно ≥1200px. */}
              <div className={`flex-col min-h-0 border-r border-border ${
                trackOpen && selectedIssueId
                  ? `w-[280px] shrink-0 hidden ${WIDE}`
                  : detailExpanded && selectedIssueId ? 'hidden' : 'flex flex-1 min-w-0'
              }`}>
                <IssuesList viewMode={viewMode} onViewModeChange={setViewMode} />
              </div>

              <TrackSlot issueId={selectedIssueId} open={trackOpen} />

              {selectedIssueId && (
                <div className={`${RAIL_W} shrink-0 border-l border-border flex flex-col min-h-0 overflow-hidden`}>
                  <IssueDetail />
                </div>
              )}
            </div>
          </>
        ) : section === 'ai_feedback' ? (
          <AiFeedbackReview onOpenIssue={() => setSection('issues')} />
        ) : section === 'settings' ? (
          <TemplatesManager />
        ) : (
          <StubSection section={section as Exclude<Section, 'issues' | 'chat' | 'ai_feedback' | 'settings'>} />
        )}
      </div>
    </div>
  )
}

const SECTION_ICON: Record<Section, LucideIcon> = {
  issues: ClipboardList, chat: MessageSquare, ai_feedback: ThumbsUp, mango: Phone, installers: Truck, analytics: BarChart3, settings: Settings,
}

function sectionTitle(s: Section): string {
  const map: Record<Section, string> = {
    issues: 'Заявки',
    chat: 'ИИ-чат',
    ai_feedback: 'Оценки ИИ',
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
