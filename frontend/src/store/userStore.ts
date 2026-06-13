import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Employee {
  id: number
  name: string
  group: string
}

export const EMPLOYEES: Employee[] = [
  { id: 1, name: 'Свириденко', group: 'Первая линия' },
  { id: 2, name: 'Рогозин', group: 'Первая линия' },
  { id: 3, name: 'Лебедь', group: 'Вторая линия' },
  { id: 4, name: 'Игнашкин', group: 'Вторая линия' },
]

interface UserStore {
  currentUser: Employee | null
  setCurrentUser: (user: Employee | null) => void
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      currentUser: null,
      setCurrentUser: (user) => set({ currentUser: user }),
    }),
    { name: 'gpspos-current-user' }
  )
)
