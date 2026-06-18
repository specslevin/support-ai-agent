import { useState } from 'react'
import { Loader2, LogIn, Eye, EyeOff } from 'lucide-react'
import { authApi } from '../api/client'
import { useAuthStore } from '../store/authStore'

export function Login() {
  const setAuth = useAuthStore(s => s.setAuth)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password.trim()) return
    setError(null)
    setLoading(true)
    try {
      const result = await authApi.login(username.trim(), password)
      setAuth(result.token, result.user)
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { detail?: string }; status?: number } }
      if (axiosErr?.response?.status === 401) {
        setError('Неверный логин или пароль')
      } else {
        setError('Ошибка соединения. Попробуйте ещё раз.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen bg-base items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent/10 border border-accent/30 mb-4">
            <LogIn size={22} className="text-accent" />
          </div>
          <h1 className="text-xl font-bold text-white">Support AI Agent</h1>
          <p className="text-sm text-muted mt-1">Войдите, чтобы продолжить</p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-lg">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Username */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-secondary uppercase tracking-widest">
                Логин
              </label>
              <input
                type="text"
                value={username}
                onChange={e => { setUsername(e.target.value); setError(null) }}
                placeholder="Введите логин..."
                autoComplete="username"
                autoFocus
                className="w-full bg-frame border border-border rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent transition-colors"
              />
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-secondary uppercase tracking-widest">
                Пароль
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(null) }}
                  placeholder="Введите пароль..."
                  autoComplete="current-password"
                  className="w-full bg-frame border border-border rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder:text-muted focus:outline-none focus:border-accent transition-colors"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div className="text-xs text-orange-400 bg-orange-400/10 border border-orange-400/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username.trim() || !password.trim()}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-accent text-base font-semibold rounded-lg hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-sm mt-1"
            >
              {loading
                ? <><Loader2 size={15} className="animate-spin" /> Вход...</>
                : <><LogIn size={15} /> Войти</>
              }
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
