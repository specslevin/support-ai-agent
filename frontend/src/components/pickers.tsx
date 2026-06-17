import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { EMPLOYEES } from '../store/userStore'

type Employee = (typeof EMPLOYEES)[number]

/**
 * Список сотрудников, сгруппированный по отделам.
 * Рендерит только содержимое меню — обёртку/позиционирование задаёт вызывающий
 * (используется в шапке «Я:», bulk-панели списка и карточке заявки).
 */
export function EmployeeMenu({
  selectedName,
  selectedId,
  onPick,
}: {
  selectedName?: string | null
  selectedId?: number | null
  onPick: (emp: Employee) => void
}) {
  const groups = EMPLOYEES.reduce<Record<string, Employee[]>>((acc, e) => {
    ;(acc[e.group] ??= []).push(e)
    return acc
  }, {})

  return (
    <>
      {Object.entries(groups).map(([group, members]) => (
        <div key={group}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-muted/60">{group}</div>
          {members.map(emp => {
            const active = selectedId != null ? emp.id === selectedId : emp.name === selectedName
            return (
              <button
                key={emp.id}
                onClick={() => onPick(emp)}
                className={`w-full text-left px-4 py-1.5 text-xs hover:bg-white/5 transition-colors ${active ? 'text-accent' : 'text-white'}`}
              >
                {emp.name}
              </button>
            )
          })}
        </div>
      ))}
    </>
  )
}

/**
 * Список типов заявок (из Okdesk). Рендерит только содержимое меню.
 * Используется в bulk-панели списка и в карточке заявки.
 */
export function TypeMenu({
  selectedCode,
  onPick,
}: {
  selectedCode?: string | null
  onPick: (type: { code: string; name: string }) => void
}) {
  const { data: types = [] } = useQuery({
    queryKey: ['issue-types'],
    queryFn: () => api.listIssueTypes(),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <>
      {types.map(t => (
        <button
          key={t.code}
          onClick={() => onPick(t)}
          className={`w-full text-left px-4 py-1.5 text-xs hover:bg-white/5 transition-colors ${t.code === selectedCode ? 'text-accent' : 'text-white'}`}
        >
          {t.name}
        </button>
      ))}
    </>
  )
}
