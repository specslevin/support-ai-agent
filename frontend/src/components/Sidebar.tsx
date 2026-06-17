import { useState, useEffect } from 'react'
import {
  ClipboardList,
  MessageSquare,
  Phone,
  Truck,
  BarChart3,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react'

export type Section = 'issues' | 'chat' | 'mango' | 'installers' | 'analytics' | 'settings'

type NavEntry = {
  id: Section
  label: string
  icon: LucideIcon
  /** заглушка — функционал ещё не реализован */
  stub?: boolean
}

const NAV: NavEntry[] = [
  { id: 'issues', label: 'Заявки', icon: ClipboardList },
  { id: 'chat', label: 'ИИ-чат', icon: MessageSquare },
  { id: 'mango', label: 'Mango — звонки', icon: Phone, stub: true },
  { id: 'installers', label: 'Выезды монтажников', icon: Truck, stub: true },
  { id: 'analytics', label: 'Аналитика', icon: BarChart3, stub: true },
  { id: 'settings', label: 'Настройки', icon: Settings, stub: true },
]

const STORAGE_KEY = 'sidebar.expanded'

export function Sidebar({
  active,
  onSelect,
}: {
  active: Section
  onSelect: (s: Section) => void
}) {
  // Свёрнут по умолчанию (скрытый/закрытый), состояние persist в localStorage
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, expanded ? '1' : '0')
    } catch {
      /* noop */
    }
  }, [expanded])

  return (
    <aside
      className={`shrink-0 flex flex-col bg-darker border-r border-border transition-[width] duration-200 ${
        expanded ? 'w-56' : 'w-14'
      }`}
    >
      {/* Логотип + toggle */}
      <div className="flex items-center h-14 px-3 border-b border-border">
        {expanded && (
          <span className="text-accent font-bold text-sm tracking-tight flex-1 truncate">
            GPSPOS
          </span>
        )}
        <button
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Свернуть меню' : 'Развернуть меню'}
          className="text-muted hover:text-accent transition-colors p-1 rounded-md hover:bg-card mx-auto"
        >
          {expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
      </div>

      {/* Навигация */}
      <nav className="flex-1 py-2 flex flex-col gap-0.5">
        {NAV.map(item => {
          const Icon = item.icon
          const isActive = item.id === active
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              title={!expanded ? item.label : undefined}
              className={`relative flex items-center gap-3 mx-1.5 px-2.5 h-9 rounded-md font-nav text-sm transition-colors ${
                isActive
                  ? 'text-accent bg-card'
                  : 'text-secondary hover:text-accent hover:bg-card'
              }`}
            >
              {/* активный индикатор слева */}
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
              )}
              <Icon size={18} className="shrink-0" />
              {expanded && (
                <span className="flex-1 text-left truncate">{item.label}</span>
              )}
              {expanded && item.stub && (
                <span className="text-[10px] uppercase tracking-wide text-muted/70 rounded bg-frame px-1.5 py-0.5">
                  скоро
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Подвал */}
      {expanded && (
        <div className="px-3 py-2.5 border-t border-border text-[11px] text-muted">
          support-ai-agent
        </div>
      )}
    </aside>
  )
}
