import { useEffect, useState } from 'react'
import { Lock, X } from 'lucide-react'

export function DemoToast() {
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      setMessage(detail || 'Демо-режим: только просмотр. Изменения недоступны.')
    }
    window.addEventListener('auth:demo-blocked', handler)
    return () => window.removeEventListener('auth:demo-blocked', handler)
  }, [])

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])

  if (!message) return null

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 px-4 py-2.5 bg-card border border-warning/40 rounded-xl shadow-xl text-xs text-warning max-w-sm">
      <Lock size={13} className="shrink-0" />
      <span className="flex-1">{message}</span>
      <button onClick={() => setMessage(null)} className="text-muted hover:text-white transition-colors ml-1 shrink-0">
        <X size={13} />
      </button>
    </div>
  )
}
