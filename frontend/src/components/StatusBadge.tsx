import { STATUS_LABEL, statusPillStyle } from '../lib/status'

export function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? ''
  const label = STATUS_LABEL[s]
  if (!label) {
    return (
      <span className="inline-block text-xs px-2.5 py-0.5 rounded-pill font-medium bg-gray-700 text-gray-300 whitespace-nowrap">
        {s || '—'}
      </span>
    )
  }
  return (
    <span
      style={statusPillStyle(s)}
      className="inline-block text-xs px-2.5 py-0.5 rounded-pill font-medium whitespace-nowrap"
    >
      {label}
    </span>
  )
}
