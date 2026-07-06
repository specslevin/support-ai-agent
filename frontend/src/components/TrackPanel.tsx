import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Calendar, ChevronLeft, ChevronRight, Check, Copy, RotateCcw, PanelLeftClose } from 'lucide-react'
import L from 'leaflet'
import uPlot from 'uplot'
import 'leaflet/dist/leaflet.css'
import 'uplot/dist/uPlot.min.css'
import { api } from '../api/client'
import { useIssuesStore } from '../store/issuesStore'
import type { TrackData, TrackPoint } from '../types'

function formatTs(value?: number): string {
  if (!value) return '—'
  const ms = value > 1e12 ? value : value * 1000  // seconds vs milliseconds
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function copyText(text: string) {
  // navigator.clipboard requires a secure context (HTTPS); app runs over HTTP,
  // so fall back to a temporary textarea + execCommand.
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  } else {
    fallbackCopy(text)
  }
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch { /* ignore */ }
  document.body.removeChild(ta)
}

function Copyable({ label, value, copyValue }: { label: string; value: string | null | undefined; copyValue?: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      onClick={() => { copyText(copyValue ?? value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
      title="Копировать"
      className="flex items-center gap-1 text-[11px] text-muted hover:text-white transition-colors"
    >
      <span className="text-muted/60">{label}:</span>
      <span className="font-mono text-white/90">{value}</span>
      <span className="text-accent">{copied ? <Check size={12} /> : <Copy size={12} />}</span>
    </button>
  )
}

type MapApi = { show: (lat: number, lng: number) => void }

// Canonical uPlot wheel-zoom plugin (x-axis only), zooms around cursor.
function wheelZoomPlugin(factor = 0.75): uPlot.Plugin {
  let xMin = 0, xMax = 0, xRange = 0
  return {
    hooks: {
      ready: (u) => {
        xMin = u.scales.x.min!; xMax = u.scales.x.max!; xRange = xMax - xMin
        const over = u.over
        over.addEventListener('wheel', (e) => {
          e.preventDefault()
          const left = u.cursor.left ?? over.clientWidth / 2
          const leftPct = left / over.clientWidth
          const xVal = u.posToVal(left, 'x')
          const oxRange = u.scales.x.max! - u.scales.x.min!
          const nxRange = e.deltaY < 0 ? oxRange * factor : oxRange / factor
          let nxMin = xVal - leftPct * nxRange
          let nxMax = nxMin + nxRange
          if (nxRange > xRange) { nxMin = xMin; nxMax = xMax }
          else if (nxMin < xMin) { nxMin = xMin; nxMax = xMin + nxRange }
          else if (nxMax > xMax) { nxMax = xMax; nxMin = xMax - nxRange }
          u.setScale('x', { min: nxMin, max: nxMax })
        })
      },
    },
  }
}

function TrackMap({ data, apiRef }: { data: TrackData; apiRef: React.MutableRefObject<MapApi | null> }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const map = L.map(ref.current, { zoomControl: true, attributionControl: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)

    const coords = data.points
      .filter(p => p.lat != null && p.lng != null)
      .map(p => [p.lat as number, p.lng as number] as [number, number])

    let cursor: L.CircleMarker | null = null
    if (coords.length) {
      L.polyline(coords, { color: '#ef4444', weight: 2.5, opacity: 0.85 }).addTo(map)
      for (const i of data.teleports ?? []) {
        const a = data.points[i - 1], b = data.points[i]
        if (a?.lat != null && a?.lng != null && b?.lat != null && b?.lng != null) {
          L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
            color: '#fbbf24', weight: 3, dashArray: '6 4', opacity: 0.95,
          }).addTo(map)
        }
      }
      L.circleMarker(coords[0], { radius: 6, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1 }).addTo(map).bindTooltip('Старт')
      L.circleMarker(coords[coords.length - 1], { radius: 6, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 1 }).addTo(map).bindTooltip('Финиш')
      map.fitBounds(L.latLngBounds(coords).pad(0.1))
      cursor = L.circleMarker(coords[0], {
        radius: 8, color: '#ffffff', weight: 3, fillColor: '#a855f7', fillOpacity: 1, pane: 'markerPane',
      }).addTo(map)
    } else {
      map.setView([55.75, 37.62], 5)
    }
    setTimeout(() => map.invalidateSize(), 100)
    // Re-measure on any container resize (panel slide animation, window resize)
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(ref.current)

    apiRef.current = {
      show: (lat, lng) => {
        if (!cursor) return
        cursor.setLatLng([lat, lng])
        cursor.bringToFront()
      },
    }
    return () => { ro.disconnect(); map.remove(); apiRef.current = null }
  }, [data, apiRef])

  return <div ref={ref} className="w-full h-full rounded-lg overflow-hidden" />
}

function haversine(a: number, b: number, c: number, d: number): number {
  const R = 6371000, rad = Math.PI / 180
  const dlat = (c - a) * rad, dlng = (d - b) * rad
  const x = Math.sin(dlat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dlng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

interface IntervalStats {
  distanceKm: number; maxSpeed: number; avgSpeed: number
  avgSat: number; minPwr: number | null; durationMin: number; points: number
}

function computeStats(points: TrackPoint[], minSec: number, maxSec: number): IntervalStats {
  const inRange = points.filter(p => {
    const t = (p.t ?? 0) / 1000
    return t >= minSec && t <= maxSec
  })
  let dist = 0
  let prev: TrackPoint | null = null
  let maxSpeed = 0
  let satSum = 0, satN = 0
  let minPwr: number | null = null
  for (const p of inRange) {
    maxSpeed = Math.max(maxSpeed, p.speed)
    if (p.sat != null) { satSum += p.sat; satN++ }
    if (p.pwr != null) minPwr = minPwr == null ? p.pwr : Math.min(minPwr, p.pwr)
    if (prev && prev.lat != null && prev.lng != null && p.lat != null && p.lng != null) {
      dist += haversine(prev.lat, prev.lng, p.lat, p.lng)
    }
    if (p.lat != null && p.lng != null) prev = p
  }
  const durationMin = (maxSec - minSec) / 60
  const distanceKm = dist / 1000
  const avgSpeed = durationMin > 0 ? distanceKm / (durationMin / 60) : 0
  return {
    distanceKm, maxSpeed, avgSpeed,
    avgSat: satN ? satSum / satN : 0,
    minPwr, durationMin, points: inRange.length,
  }
}

function StatsBar({ s, zoomed }: { s: IntervalStats; zoomed: boolean }) {
  const cell = (label: string, value: string) => (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider text-muted/50">{label}</span>
      <span className="text-xs text-white">{value}</span>
    </div>
  )
  return (
    <div className="px-3 py-2 border-t border-border bg-surface/40">
      <div className="text-[9px] uppercase tracking-widest text-muted/40 mb-1.5">
        {zoomed ? 'Выбранный интервал' : 'За день'}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {cell('Пробег', `${s.distanceKm.toFixed(1)} км`)}
        {cell('Макс. скорость', `${Math.round(s.maxSpeed)} км/ч`)}
        {cell('Ср. скорость', `${Math.round(s.avgSpeed)} км/ч`)}
        {cell('Спутники', s.avgSat.toFixed(1))}
        {cell('Питание мин.', s.minPwr != null ? `${s.minPwr} В` : '—')}
        {cell('Длительность', s.durationMin >= 60 ? `${(s.durationMin / 60).toFixed(1)} ч` : `${Math.round(s.durationMin)} мин`)}
      </div>
    </div>
  )
}

function TelemetryCharts({ data, apiRef, onRange }: { data: TrackData; apiRef: React.MutableRefObject<MapApi | null>; onRange: (min: number, max: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const pts: TrackPoint[] = data.points
    const xs = pts.map(p => (p.t ?? 0) / 1000)
    const speed = pts.map(p => p.speed)
    const pwr = pts.map(p => p.pwr)
    const sat = pts.map(p => p.sat)

    const width = ref.current.clientWidth || 600
    const opts: uPlot.Options = {
      width,
      height: 260,
      cursor: { drag: { x: true, y: false } },
      legend: { show: true },
      scales: { x: { time: true }, spd: {}, pwr: {}, sat: {} },
      axes: [
        {
          // Подписи времени под графиком: цвет вторичного текста (UI Kit),
          // 24-часовой формат и русские даты (ДД.ММ) на смене суток.
          stroke: '#ACC3A7',
          font: '11px Inter, system-ui, sans-serif',
          grid: { show: true, stroke: '#ffffff0d' },
          ticks: { show: true, stroke: '#ffffff1a' },
          values: (_u, splits) => {
            let lastDay = ''
            return splits.map(s => {
              const d = new Date(s * 1000)
              const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
              const day = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
              if (day !== lastDay) { lastDay = day; return `${day} ${time}` }
              return time
            })
          },
        },
        { scale: 'spd', stroke: '#22c55e', grid: { show: true, stroke: '#ffffff10' } },
        { scale: 'pwr', stroke: '#ef4444', side: 1 },
      ],
      series: [
        {
          // Значение времени в легенде/курсоре: русский формат ДД.ММ.ГГГГ ЧЧ:ММ (24ч).
          value: (_u, v) => {
            if (v == null) return '—'
            const d = new Date(v * 1000)
            return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
          },
        },
        { label: 'Скорость, км/ч', stroke: '#22c55e', width: 1.2, scale: 'spd' },
        { label: 'Напряжение, В', stroke: '#ef4444', width: 1.2, scale: 'pwr' },
        { label: 'Спутники', stroke: '#3b82f6', width: 1.2, scale: 'sat' },
      ],
      plugins: [wheelZoomPlugin()],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx
            if (idx == null) return
            const p = pts[idx]
            if (p?.lat != null && p?.lng != null) apiRef.current?.show(p.lat, p.lng)
          },
        ],
        setScale: [
          (u, key) => {
            if (key === 'x' && u.scales.x.min != null && u.scales.x.max != null) {
              onRange(u.scales.x.min, u.scales.x.max)
            }
          },
        ],
      },
    }
    const u = new uPlot(opts, [xs, speed, pwr, sat], ref.current)
    if (xs.length) onRange(xs[0], xs[xs.length - 1])
    // Track real container width (panel slide animation, window resize, etc.)
    const ro = new ResizeObserver(() => {
      const w = ref.current?.clientWidth || 0
      if (w > 0) u.setSize({ width: w, height: 260 })
    })
    ro.observe(ref.current)
    return () => { ro.disconnect(); u.destroy() }
  }, [data, apiRef])

  return <div ref={ref} className="w-full" />
}

function pad(n: number) { return String(n).padStart(2, '0') }
function isoOf(y: number, m: number, d: number) { return `${y}-${pad(m + 1)}-${pad(d)}` }
function ruShort(iso: string) { const [, m, d] = iso.split('-'); return `${d}.${m}` }

interface DateRangePickerProps {
  from: string
  to: string
  timeFrom: string
  timeTo: string
  onChange: (f: string, t: string, tf: string, tt: string) => void
}

// Range calendar: 1st click = start, 2nd click = end (one day = click same date twice).
// timeFrom/timeTo are HH:MM strings (empty = whole day, no time suffix).
function DateRangePicker({ from, to, timeFrom, timeTo, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [pend, setPend] = useState<string | null>(null)
  const [localTimeFrom, setLocalTimeFrom] = useState(timeFrom)
  const [localTimeTo, setLocalTimeTo] = useState(timeTo)
  const init = from || to || isoOf(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
  const [yy, mm] = init.split('-').map(Number)
  const [view, setView] = useState<[number, number]>([yy, mm - 1])

  // Sync local time state when prop changes (e.g. reset)
  useEffect(() => { setLocalTimeFrom(timeFrom) }, [timeFrom])
  useEffect(() => { setLocalTimeTo(timeTo) }, [timeTo])

  const [vy, vm] = view
  const daysIn = new Date(vy, vm + 1, 0).getDate()
  const startWd = (new Date(vy, vm, 1).getDay() + 6) % 7
  const cells: (string | null)[] = Array(startWd).fill(null)
  for (let d = 1; d <= daysIn; d++) cells.push(isoOf(vy, vm, d))

  const now = new Date()
  const todayIso = isoOf(now.getFullYear(), now.getMonth(), now.getDate())

  const click = (iso: string) => {
    if (!pend) { setPend(iso); return }
    const [lo, hi] = pend <= iso ? [pend, iso] : [iso, pend]
    onChange(lo, hi, localTimeFrom, localTimeTo); setPend(null); setOpen(false)
  }
  const close = () => { setOpen(false); setPend(null) }

  const applyTime = () => {
    onChange(from, to, localTimeFrom, localTimeTo)
    setOpen(false)
  }

  // Display label in button
  const dateLabel = from === to ? ruShort(from) : `${ruShort(from)} — ${ruShort(to)}`
  const timeLabel = localTimeFrom || localTimeTo
    ? ` ${localTimeFrom || '00:00'}–${localTimeTo || '23:59'}`
    : ''

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 bg-base border border-border rounded-lg px-2 py-0.5 text-[11px] text-white hover:border-accent transition-colors"
      >
        <Calendar size={12} className="text-muted" /> {dateLabel}{timeLabel}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full mt-1 z-[1100] bg-surface border border-border rounded-lg p-2 shadow-2xl w-56">
            <div className="flex items-center justify-between mb-1 text-xs">
              <button onClick={() => setView([vm === 0 ? vy - 1 : vy, vm === 0 ? 11 : vm - 1])} className="flex items-center px-2 text-muted hover:text-white"><ChevronLeft size={14} /></button>
              <span className="text-white capitalize">{new Date(vy, vm, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</span>
              <button onClick={() => setView([vm === 11 ? vy + 1 : vy, vm === 11 ? 0 : vm + 1])} className="flex items-center px-2 text-muted hover:text-white"><ChevronRight size={14} /></button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-[10px]">
              {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(w => <div key={w} className="text-muted/40 text-center py-0.5">{w}</div>)}
              {cells.map((iso, i) => {
                if (!iso) return <div key={i} />
                const inRange = !pend && iso >= from && iso <= to
                const isPend = iso === pend
                const isToday = iso === todayIso
                return (
                  <button
                    key={i}
                    onClick={() => click(iso)}
                    className={`text-center py-0.5 rounded transition-colors ${isPend ? 'bg-accent text-black' : inRange ? 'bg-accent/25 text-white' : 'text-white hover:bg-white/10'} ${isToday ? 'ring-1 ring-accent/60' : ''}`}
                  >
                    {Number(iso.slice(8))}
                  </button>
                )
              })}
            </div>
            <div className="text-[10px] text-muted/70 mt-1 text-center">
              {pend ? 'Выберите конечную дату (или ту же — один день)' : 'Выберите начало интервала'}
            </div>
            {/* Time inputs */}
            <div className="mt-2 pt-2 border-t border-border flex flex-col gap-1.5">
              <div className="text-[10px] text-muted/60 text-center">Время (МСК, необязательно)</div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-muted w-7 shrink-0">с</label>
                <input
                  type="time"
                  value={localTimeFrom}
                  onChange={e => setLocalTimeFrom(e.target.value)}
                  className="flex-1 bg-base border border-border rounded px-1.5 py-0.5 text-[11px] text-white focus:border-accent outline-none"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-muted w-7 shrink-0">по</label>
                <input
                  type="time"
                  value={localTimeTo}
                  onChange={e => setLocalTimeTo(e.target.value)}
                  className="flex-1 bg-base border border-border rounded px-1.5 py-0.5 text-[11px] text-white focus:border-accent outline-none"
                />
              </div>
              <button
                onClick={applyTime}
                className="mt-0.5 w-full text-[11px] bg-accent/10 hover:bg-accent/20 border border-accent/30 hover:border-accent text-accent rounded px-2 py-1 transition-colors"
              >
                Применить время
              </button>
              {(localTimeFrom || localTimeTo) && (
                <button
                  onClick={() => { setLocalTimeFrom(''); setLocalTimeTo(''); onChange(from, to, '', '') }}
                  className="w-full text-[10px] text-muted hover:text-white transition-colors"
                >
                  Сбросить время
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function TrackPanel({ issueId }: { issueId: number }) {
  const mapApi = useRef<MapApi | null>(null)
  const setTrackOpen = useIssuesStore(s => s.setTrackOpen)
  const trackPlate = useIssuesStore(s => s.trackPlate)
  const trackDate = useIssuesStore(s => s.trackDate)
  const [range, setRange] = useState<[number, number] | null>(null)
  const fullRangeRef = useRef<[number, number] | null>(null)
  const onRange = useCallback((min: number, max: number) => setRange([min, max]), [])
  // Custom date interval (null → use issue's fault date)
  // timeFrom/timeTo are HH:MM or '' (empty = whole day, sends date only)
  const [interval, setInterval] = useState<{ from: string; to: string; timeFrom: string; timeTo: string } | null>(null)
  // Reset interval when switching to another object/issue.
  useEffect(() => { setInterval(null) }, [issueId, trackPlate, trackDate])

  // Build date_from / date_to strings: append time suffix when set
  const dateFrom = interval
    ? (interval.timeFrom ? `${interval.from}T${interval.timeFrom}` : interval.from)
    : null
  const dateTo = interval
    ? (interval.timeTo ? `${interval.to}T${interval.timeTo}` : interval.to)
    : null

  const { data, isPending, isError } = useQuery({
    queryKey: ['track', issueId, trackPlate, trackDate, dateFrom, dateTo],
    queryFn: () => api.getTrack(issueId, trackPlate, trackDate, dateFrom, dateTo),
    staleTime: 5 * 60_000,
  })

  const stats = useMemo(() => {
    if (!data?.points?.length || !range) return null
    return computeStats(data.points, range[0], range[1])
  }, [data, range])

  const fullSpan = data?.points?.length
    ? [(data.points[0].t ?? 0) / 1000, (data.points[data.points.length - 1].t ?? 0) / 1000]
    : null
  if (fullSpan) fullRangeRef.current = fullSpan as [number, number]
  const zoomed = !!(range && fullRangeRef.current &&
    (range[0] > fullRangeRef.current[0] + 1 || range[1] < fullRangeRef.current[1] - 1))

  if (isPending) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">Загрузка трека...</div>
  }
  if (isError) {
    return <div className="flex items-center justify-center h-full text-red-400 text-sm">Ошибка загрузки трека</div>
  }
  if (data.error) {
    const msg = data.error === 'object_not_found' ? 'Объект не найден в geo'
      : data.error === 'no_plate' ? 'В заявке не найден гос.номер ТС (возможно, это общая/внутренняя заявка на несколько ТС)'
      : data.error === 'no_date' ? 'Гос.номер найден, но не указана дата неисправности — задайте период вручную через календарь'
      : data.error === 'no_plate_or_date' ? 'В заявке не указан один гос.номер ТС или дата (возможно, это общая/внутренняя заявка на несколько ТС)'
      : 'Нет данных'
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2.5 border-b border-border shrink-0">
          <button onClick={() => setTrackOpen(false)} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg border border-border text-muted hover:text-white hover:border-accent transition-colors"><PanelLeftClose size={13} /> Свернуть</button>
        </div>
        <div className="flex items-center justify-center flex-1 text-muted text-sm px-4 text-center">{msg}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-2.5 border-b border-border shrink-0 space-y-1.5 text-right">
        <div className="flex items-start gap-2 justify-end">
          <div className="min-w-0">
            <div className="text-xs text-white font-medium truncate">{data.object_name}</div>
            <div className="text-[11px] text-muted">
              {data.total_packets ?? 0} точек
              {(data.teleports?.length ?? 0) > 0 && (
                <span className="text-yellow-400"> · {data.teleports!.length} телепортов (глушение)</span>
              )}
            </div>
          </div>
          <button
            onClick={() => setTrackOpen(false)}
            title="Свернуть панель"
            className="flex items-center gap-1 shrink-0 text-xs px-2 py-0.5 rounded-lg border border-border text-muted hover:text-white hover:border-accent transition-colors"
          >
            Свернуть <PanelLeftClose size={13} />
          </button>
        </div>
        {/* Текущее состояние объекта */}
        <div className="flex items-center flex-wrap justify-end gap-x-3 gap-y-1">
          <span className={`flex items-center gap-1.5 text-[11px] font-medium ${data.status?.online ? 'text-green-400' : 'text-muted'}`}>
            <span className={`w-2 h-2 rounded-full ${data.status?.online ? 'bg-green-400' : 'border border-muted'}`} />
            {data.status?.online ? 'На связи' : 'Не в сети'}
          </span>
          {data.status?.last_time != null && (
            <span className="text-[11px] text-muted">посл. сообщение: {formatTs(data.status.last_time)}</span>
          )}
          <Copyable label="IMEI" value={data.imei} />
          <Copyable label="тел" value={data.phone} copyValue={data.phone?.replace(/^\+/, '')} />
        </div>
        {/* Интервал дат */}
        <div className="flex items-center justify-end gap-1.5 text-[11px]">
          <span className="text-muted/60">период:</span>
          <DateRangePicker
            from={interval?.from ?? data.range_from ?? ''}
            to={interval?.to ?? data.range_to ?? ''}
            timeFrom={interval?.timeFrom ?? ''}
            timeTo={interval?.timeTo ?? ''}
            onChange={(f, t, tf, tt) => setInterval({ from: f, to: t, timeFrom: tf, timeTo: tt })}
          />
          {interval && (
            <button onClick={() => setInterval(null)} title="Сбросить к дате неисправности" className="flex items-center text-muted hover:text-accent"><RotateCcw size={12} /></button>
          )}
        </div>
      </div>
      {data.points.length ? (
        <>
          <div className="h-[50%] min-h-[240px] p-3 shrink-0 isolate">
            <TrackMap data={data} apiRef={mapApi} />
          </div>
          {stats && <StatsBar s={stats} zoomed={zoomed} />}
          <div className="border-t border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">Телеметрия за день</span>
              <span className="text-[10px] text-muted/50">колёсико — зум · наведение — точка на карте</span>
            </div>
            <TelemetryCharts data={data} apiRef={mapApi} onRange={onRange} />
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center flex-1 text-muted text-sm px-4 text-center">
          Нет данных трека за период {data.range_from}{data.range_to !== data.range_from ? ` — ${data.range_to}` : ''} — терминал не передавал данные (статус объекта см. выше).
        </div>
      )}
    </div>
  )
}
