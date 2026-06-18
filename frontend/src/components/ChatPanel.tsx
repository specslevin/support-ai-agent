import { useState, useRef, useEffect } from 'react'
import { MessageSquare, Send, Sparkles, Loader2 } from 'lucide-react'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import type { ChatIssue } from '../types'

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

const STATUS_LABEL: Record<string, string> = {
  opened: 'Открыта',
  wait: 'В ожидании',
  delayed: 'Отложена',
  completed: 'Выполнена',
  closed: 'Закрыта',
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return null
  return (
    <span className="text-[10px] uppercase tracking-wide rounded bg-frame px-1.5 py-0.5 text-muted">
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function IssueCard({ issue }: { issue: ChatIssue }) {
  const selectIssue = useIssuesStore(s => s.selectIssue)
  const selectedIssueId = useIssuesStore(s => s.selectedIssueId)
  const isActive = selectedIssueId === issue.id
  return (
    <button
      onClick={() => selectIssue(issue.id)}
      className={`w-full text-left rounded-lg border p-3 transition-colors bg-card hover:border-accent ${
        isActive ? 'border-accent' : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-white line-clamp-2">
          {issue.subject ?? 'Без темы'}
        </span>
        <StatusBadge status={issue.status} />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
        {issue.external_id != null && <span className="text-secondary">#{issue.external_id}</span>}
        {issue.company_name && <span className="truncate">{issue.company_name}</span>}
      </div>
      {issue.assignee_name && (
        <div className="mt-1 text-[11px] text-muted/80 truncate">Ответственный: {issue.assignee_name}</div>
      )}
    </button>
  )
}

export function ChatPanel() {
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [issues, setIssues] = useState<ChatIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, loading])

  const send = async () => {
    const message = input.trim()
    if (!message || loading) return
    setInput('')
    setError(null)
    setTurns(t => [...t, { role: 'user', content: message }])
    setLoading(true)
    try {
      const res = await api.chat(message)
      setTurns(t => [...t, { role: 'assistant', content: res.reply }])
      setIssues(res.issues)
    } catch {
      setError('Не удалось обработать запрос. Попробуйте ещё раз.')
      setTurns(t => [...t, { role: 'assistant', content: 'Произошла ошибка при обработке запроса.' }])
    } finally {
      setLoading(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* Левая панель — чат */}
      <div className="flex flex-col w-2/5 min-w-[320px] border-r border-border min-h-0">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
          {turns.length === 0 && (
            <div className="m-auto text-center text-muted max-w-xs">
              <Sparkles size={28} className="text-accent mx-auto mb-3" />
              <p className="text-sm text-secondary">Спросите про заявки на естественном языке</p>
              <p className="text-xs mt-2 text-muted/70">Например: «покажи открытые заявки Жигулёвского ПО»</p>
            </div>
          )}
          {turns.map((turn, i) => (
            <div key={i} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  turn.role === 'user'
                    ? 'bg-accent text-base font-medium'
                    : 'bg-card border border-border text-white'
                }`}
              >
                {turn.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 bg-card border border-accent/40 text-secondary flex items-center gap-2 text-sm">
                <Loader2 size={15} className="animate-spin text-accent" />
                <span>ИИ думает…</span>
                <span className="flex gap-0.5 ml-0.5">
                  <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />
                  <span className="w-1 h-1 rounded-full bg-accent animate-pulse [animation-delay:150ms]" />
                  <span className="w-1 h-1 rounded-full bg-accent animate-pulse [animation-delay:300ms]" />
                </span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 text-xs text-red-400 border-t border-border">{error}</div>
        )}

        <div className="border-t border-border p-3 flex items-center gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={loading ? 'ИИ думает…' : 'Опишите, какие заявки нужны...'}
            disabled={loading}
            className="flex-1 bg-frame border border-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-muted/60 focus:outline-none focus:border-accent transition-colors disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-accent text-base hover:opacity-90 transition-opacity disabled:opacity-40"
            title={loading ? 'ИИ думает…' : 'Отправить'}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>

      {/* Правая панель — результаты */}
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border shrink-0">
          <MessageSquare size={15} className="text-accent" />
          <span className="text-sm font-medium text-white">Найденные заявки</span>
          {issues.length > 0 && <span className="text-xs text-muted">({issues.length})</span>}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {issues.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted/70">
              Результаты появятся здесь
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5">
              {issues.map(issue => (
                <IssueCard key={issue.id} issue={issue} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
