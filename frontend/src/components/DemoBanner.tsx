import { Eye } from 'lucide-react'

export function DemoBanner() {
  return (
    <div className="flex items-center gap-2.5 px-6 py-2 bg-warning/10 border-b border-warning/30 text-xs text-warning shrink-0">
      <Eye size={13} className="shrink-0" />
      <span>
        <span className="font-semibold">Демо-режим:</span>{' '}
        просмотр без изменений. Вы видите проект в режиме только для чтения.
      </span>
    </div>
  )
}
