import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import uPlot from 'uplot'
import 'leaflet/dist/leaflet.css'
import 'uplot/dist/uPlot.min.css'
import { api } from '../api/client'
import type { TrackData } from '../types'

function TrackMap({ data }: { data: TrackData }) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const map = L.map(ref.current, { zoomControl: true, attributionControl: false })
    mapRef.current = map
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)

    const coords = data.points
      .filter(p => p.lat != null && p.lng != null)
      .map(p => [p.lat as number, p.lng as number] as [number, number])

    if (coords.length) {
      L.polyline(coords, { color: '#ef4444', weight: 2.5, opacity: 0.85 }).addTo(map)

      // Highlight teleport jumps (GPS spoofing) as dashed bright segments
      for (const i of data.teleports ?? []) {
        const a = data.points[i - 1], b = data.points[i]
        if (a?.lat != null && a?.lng != null && b?.lat != null && b?.lng != null) {
          L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
            color: '#fbbf24', weight: 3, dashArray: '6 4', opacity: 0.95,
          }).addTo(map)
        }
      }

      L.circleMarker(coords[0], { radius: 6, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1 })
        .addTo(map).bindTooltip('Старт')
      L.circleMarker(coords[coords.length - 1], { radius: 6, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 1 })
        .addTo(map).bindTooltip('Финиш')
      map.fitBounds(L.latLngBounds(coords).pad(0.1))
    } else {
      map.setView([55.75, 37.62], 5)
    }
    setTimeout(() => map.invalidateSize(), 100)
    return () => { map.remove(); mapRef.current = null }
  }, [data])

  return <div ref={ref} className="w-full h-full rounded-lg overflow-hidden" />
}

function TelemetryCharts({ data }: { data: TrackData }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const pts = data.points
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
        {},
        { scale: 'spd', stroke: '#22c55e', grid: { show: true, stroke: '#ffffff10' } },
        { scale: 'pwr', stroke: '#ef4444', side: 1 },
      ],
      series: [
        {},
        { label: 'Скорость, км/ч', stroke: '#22c55e', width: 1.2, scale: 'spd' },
        { label: 'Напряжение, В', stroke: '#ef4444', width: 1.2, scale: 'pwr' },
        { label: 'Спутники', stroke: '#3b82f6', width: 1.2, scale: 'sat' },
      ],
    }
    const u = new uPlot(opts, [xs, speed, pwr, sat], ref.current)
    const onResize = () => u.setSize({ width: ref.current!.clientWidth || width, height: 260 })
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); u.destroy() }
  }, [data])

  return <div ref={ref} className="w-full" />
}

export function TrackPanel({ issueId }: { issueId: number }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['track', issueId],
    queryFn: () => api.getTrack(issueId),
    staleTime: 5 * 60_000,
  })

  if (isPending) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">Загрузка трека...</div>
  }
  if (isError) {
    return <div className="flex items-center justify-center h-full text-red-400 text-sm">Ошибка загрузки трека</div>
  }
  if (data.error || !data.points.length) {
    const msg = data.error === 'object_not_found' ? 'Объект не найден в geo'
      : data.error === 'no_plate_or_date' ? 'Не удалось определить гос.номер или дату'
      : 'Нет данных трека за дату'
    return <div className="flex items-center justify-center h-full text-muted text-sm">{msg}</div>
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-2.5 border-b border-border shrink-0">
        <div className="text-xs text-white font-medium">{data.object_name}</div>
        <div className="text-[11px] text-muted">
          {data.parsed.date} · {data.total_packets} точек
          {(data.teleports?.length ?? 0) > 0 && (
            <span className="text-yellow-400"> · {data.teleports!.length} телепортов (глушение)</span>
          )}
        </div>
      </div>
      <div className="h-[55%] min-h-[260px] p-3 shrink-0">
        <TrackMap data={data} />
      </div>
      <div className="border-t border-border p-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted/60 mb-2">Телеметрия за день</div>
        <TelemetryCharts data={data} />
      </div>
    </div>
  )
}
