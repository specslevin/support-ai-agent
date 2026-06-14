import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import L from 'leaflet'
import uPlot from 'uplot'
import 'leaflet/dist/leaflet.css'
import 'uplot/dist/uPlot.min.css'
import { api } from '../api/client'
import type { TrackData, TrackPoint } from '../types'

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
      cursor = L.circleMarker(coords[0], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#a855f7', fillOpacity: 1 })
    } else {
      map.setView([55.75, 37.62], 5)
    }
    setTimeout(() => map.invalidateSize(), 100)

    apiRef.current = {
      show: (lat, lng) => {
        if (!cursor) return
        cursor.setLatLng([lat, lng])
        if (!map.hasLayer(cursor)) cursor.addTo(map)
      },
    }
    return () => { map.remove(); apiRef.current = null }
  }, [data, apiRef])

  return <div ref={ref} className="w-full h-full rounded-lg overflow-hidden" />
}

function TelemetryCharts({ data, apiRef }: { data: TrackData; apiRef: React.MutableRefObject<MapApi | null> }) {
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
      },
    }
    const u = new uPlot(opts, [xs, speed, pwr, sat], ref.current)
    const onResize = () => u.setSize({ width: ref.current!.clientWidth || width, height: 260 })
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); u.destroy() }
  }, [data, apiRef])

  return <div ref={ref} className="w-full" />
}

export function TrackPanel({ issueId }: { issueId: number }) {
  const mapApi = useRef<MapApi | null>(null)
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
        <TrackMap data={data} apiRef={mapApi} />
      </div>
      <div className="border-t border-border p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted/60">Телеметрия за день</span>
          <span className="text-[10px] text-muted/50">колёсико — зум · наведение — точка на карте</span>
        </div>
        <TelemetryCharts data={data} apiRef={mapApi} />
      </div>
    </div>
  )
}
