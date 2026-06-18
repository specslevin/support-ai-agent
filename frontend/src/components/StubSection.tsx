import { Phone, Truck, BarChart3, Construction, type LucideIcon } from 'lucide-react'
import type { Section } from './Sidebar'

const META: Record<Exclude<Section, 'issues' | 'chat' | 'settings'>, { icon: LucideIcon; title: string; desc: string; chart?: boolean }> = {
  mango: {
    icon: Phone,
    title: 'Mango — телефония',
    desc: 'Журнал звонков, привязка к заявкам и клиентам, статистика по операторам. Раздел в разработке.',
  },
  installers: {
    icon: Truck,
    title: 'График выездов монтажников',
    desc: 'Планирование и контроль выездов: загрузка по дням, статусы, привязка к объектам. Раздел в разработке.',
    chart: true,
  },
  analytics: {
    icon: BarChart3,
    title: 'Аналитика',
    desc: 'Сводные метрики по заявкам, SLA, типам неисправностей и автоматизации ИИ. Раздел в разработке.',
    chart: true,
  },
}

/** Декоративный скелет графика (заглушка) */
function FakeChart() {
  const bars = [42, 68, 35, 80, 55, 90, 48, 72, 60, 38, 84, 50]
  const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт']
  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5">
      <div className="flex items-end gap-2 h-40">
        {bars.map((h, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
            <div
              className="w-full rounded-t bg-accent/20 hover:bg-accent/40 transition-colors"
              style={{ height: `${h}%` }}
            />
            <span className="text-[10px] text-muted">{days[i]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function StubSection({ section }: { section: Exclude<Section, 'issues' | 'chat' | 'settings'> }) {
  const meta = META[section]
  const Icon = meta.icon

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 p-10 text-center">
      <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-card border border-border">
        <Icon size={28} className="text-accent" />
      </div>
      <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-widest">
        <Construction size={14} />
        В разработке
      </div>
      <h2 className="text-xl font-bold text-white">{meta.title}</h2>
      <p className="max-w-md text-sm text-secondary leading-relaxed">{meta.desc}</p>
      {meta.chart && <FakeChart />}
    </div>
  )
}
