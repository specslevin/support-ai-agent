import axios from 'axios'
import type { IssuesListResponse, IssueDetail, Comment, Analysis, Template, TemplateCategory, TemplateCreate, TemplateUpdate, AutomationResult, TrackData, IssueAttachment, BatchResult, TemplateValues, ChatResponse, AiFeedback, AiFeedbackBody, AiFeedbackListItem, AiFeedbackRating, InstallerExport, SavedFilter, SavedFilterCreate, SavedFilterUpdate } from '../types'
import type { UserRole } from '../store/authStore'

const http = axios.create({
  baseURL: '/api/v1',
  // ИИ-анализ (OCR + LLM + телеметрия) бывает 20-40с — иначе фронт рвал запрос
  timeout: 90_000,
})

// Attach auth token to every request
http.interceptors.request.use((config) => {
  // Import lazily to avoid circular dependency at module init
  const raw = localStorage.getItem('auth')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { state?: { token?: string } }
      const token = parsed?.state?.token
      if (token) {
        config.headers = config.headers ?? {}
        config.headers['Authorization'] = `Bearer ${token}`
      }
    } catch {
      // ignore malformed storage
    }
  }
  return config
})

// Global 401 → logout; 403 → demo-mode notification
http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        // Clear auth state and trigger re-render via storage event
        localStorage.removeItem('auth')
        // Dispatch a custom event so App.tsx can react without hard reload
        window.dispatchEvent(new Event('auth:logout'))
      }
      if (error.response?.status === 403) {
        window.dispatchEvent(
          new CustomEvent('auth:demo-blocked', {
            detail: error.response.data?.detail ?? 'Демо-режим: только просмотр. Изменения недоступны.',
          })
        )
      }
    }
    return Promise.reject(error)
  }
)

// Auth-specific API calls
export interface UserOut {
  username: string
  role: UserRole
}

export interface LoginResponse {
  token: string
  user: UserOut
}

export const authApi = {
  login(username: string, password: string): Promise<LoginResponse> {
    return http.post('/auth/login', { username, password }).then(r => r.data)
  },

  getMe(): Promise<UserOut> {
    return http.get('/auth/me').then(r => r.data)
  },

  listUsers(): Promise<UserOut[]> {
    return http.get('/auth/users').then(r => r.data)
  },

  changePassword(username: string, password: string): Promise<{ ok: boolean }> {
    return http.post(`/auth/users/${username}/password`, { password }).then(r => r.data)
  },

  createUser(username: string, password: string, role: UserRole): Promise<{ ok: boolean }> {
    return http.post('/auth/users', { username, password, role }).then(r => r.data)
  },

  deleteUser(username: string): Promise<{ ok: boolean }> {
    return http.delete(`/auth/users/${username}`).then(r => r.data)
  },

  setRole(username: string, role: UserRole): Promise<{ ok: boolean }> {
    return http.post(`/auth/users/${username}/role`, { role }).then(r => r.data)
  },
}

export interface IssuesQuery {
  status?: string
  company?: string
  search?: string
  assignee?: string
  issue_id?: number
  page?: number
  limit?: number
  sort?: string
  order?: 'asc' | 'desc'
}

export const api = {
  listIssues(params: IssuesQuery = {}): Promise<IssuesListResponse> {
    return http.get('/issues', { params }).then(r => r.data)
  },

  getIssue(id: number): Promise<IssueDetail> {
    return http.get(`/issues/${id}`).then(r => r.data)
  },

  getComments(id: number): Promise<Comment[]> {
    return http.get(`/issues/${id}/comments`).then(r => r.data)
  },

  addComment(id: number, text: string, isPublic = true): Promise<{ ok: boolean }> {
    return http.post(`/issues/${id}/comments`, null, { params: { text, is_public: isPublic } }).then(r => r.data)
  },

  submitAnalysis(id: number, mileage_from_sheet: number, notes?: string): Promise<Analysis> {
    return http.post(`/issues/${id}/analysis`, { mileage_from_sheet, notes }).then(r => r.data)
  },

  // override — ручное уточнение гос.номера/даты при опечатке клиента (переанализ).
  automateIssue(id: number, override?: { plate?: string; date?: string }): Promise<AutomationResult> {
    const params: Record<string, string> = {}
    if (override?.plate) params.plate = override.plate
    if (override?.date) params.date = override.date
    return http.post(`/issues/${id}/automate`, null, Object.keys(params).length ? { params } : undefined).then(r => r.data)
  },

  getCachedAutomate(id: number): Promise<(AutomationResult & { cached: boolean; created_at?: string })> {
    return http.get(`/issues/${id}/automate`).then(r => r.data)
  },

  automateBatch(id: number): Promise<BatchResult> {
    return http.post(`/issues/${id}/automate_batch`).then(r => r.data)
  },

  getCachedBatch(id: number): Promise<(BatchResult & { cached: boolean; created_at?: string })> {
    return http.get(`/issues/${id}/automate_batch`).then(r => r.data)
  },

  // Этап 2: suggested dynamic-template placeholder values from the cached analysis.
  templateValues(id: number): Promise<TemplateValues> {
    return http.get(`/issues/${id}/template_values`).then(r => r.data)
  },

  createChildren(id: number, objects: import('../types').BatchObject[]): Promise<{ ok: boolean; created: number; failed: number; results: { plate: string; issue_id?: number; ok: boolean }[] }> {
    const payload = objects.map(o => ({
      plate: o.plate, date: o.date, address: o.address,
      sheet_mileage_km: o.sheet_mileage_km, system_mileage_km: o.system_mileage_km,
      verdict: o.verdict,
    }))
    return http.post(`/issues/${id}/create_children`, { objects: payload }).then(r => r.data)
  },

  updateBatchVerdict(id: number, plate: string, verdict: string, file?: string, date?: string): Promise<BatchResult> {
    return http.post(`/issues/${id}/batch/verdict`, { plate, verdict, ...(file ? { file } : {}), ...(date ? { date } : {}) }).then(r => r.data)
  },

  // Исправление гос.номера в разборе: бэкенд заново ищет ТС в гео по верному номеру.
  // index — точный индекс строки (нужен для строк без номера, где ключ date+file не уникален).
  updateBatchPlate(id: number, oldPlate: string, newPlate: string, date?: string, file?: string, index?: number): Promise<BatchResult> {
    return http.post(`/issues/${id}/batch/plate`, { old_plate: oldPlate, new_plate: newPlate, ...(date ? { date } : {}), ...(file ? { file } : {}), ...(index != null ? { index } : {}) }).then(r => r.data)
  },

  composeAnswer(id: number): Promise<{ answer: string }> {
    return http.post(`/issues/${id}/compose_answer`).then(r => r.data)
  },

  getTrack(id: number, plate?: string | null, date?: string | null, dateFrom?: string | null, dateTo?: string | null): Promise<TrackData> {
    const params: Record<string, string> = {}
    if (plate && date) { params.plate = plate; params.date = date }
    if (dateFrom && dateTo) { params.date_from = dateFrom; params.date_to = dateTo }
    return http.get(`/issues/${id}/track`, { params: Object.keys(params).length ? params : undefined }).then(r => r.data)
  },

  listAttachments(id: number): Promise<IssueAttachment[]> {
    return http.get(`/issues/${id}/attachments`).then(r => r.data)
  },

  attachmentUrl(id: number, attId: number): string {
    // Token in query param — browsers don't send Authorization headers for direct links/window.open
    const raw = localStorage.getItem('auth')
    let token = ''
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { state?: { token?: string } }
        token = parsed?.state?.token ?? ''
      } catch { /* ignore */ }
    }
    const qs = token ? `?token=${encodeURIComponent(token)}` : ''
    return `/api/v1/issues/${id}/attachments/${attId}/download${qs}`
  },

  refreshCache(): Promise<{ ok: boolean; synced: number }> {
    return http.get('/issues/cache/refresh').then(r => r.data)
  },

  assignIssue(issueId: number, assigneeId: number): Promise<{ ok: boolean; assignee_name: string }> {
    return http.patch(`/issues/${issueId}/assignee`, null, { params: { assignee_id: assigneeId } }).then(r => r.data)
  },

  listEmployees(): Promise<{ id: number; name: string }[]> {
    return http.get('/employees').then(r => r.data)
  },

  listTemplates(): Promise<Template[]> {
    return http.get('/templates').then(r => r.data)
  },

  listTemplateCategories(): Promise<TemplateCategory[]> {
    return http.get('/templates/categories').then(r => r.data)
  },

  createTemplate(body: TemplateCreate): Promise<Template> {
    return http.post('/templates', body).then(r => r.data)
  },

  updateTemplate(id: number, body: TemplateUpdate): Promise<Template> {
    return http.put(`/templates/${id}`, body).then(r => r.data)
  },

  deleteTemplate(id: number): Promise<{ ok: boolean }> {
    return http.delete(`/templates/${id}`).then(r => r.data)
  },

  incrementTemplateUsage(id: number): Promise<{ ok: boolean; usage_count: number }> {
    return http.post(`/templates/${id}/usage`).then(r => r.data)
  },

  createTemplateCategory(name: string, color?: string): Promise<TemplateCategory> {
    return http.post('/templates/categories', { name, ...(color ? { color } : {}) }).then(r => r.data)
  },

  listIssueTypes(): Promise<{ code: string; name: string }[]> {
    return http.get('/issue-types').then(r => r.data)
  },

  changeIssueType(id: number, type_code: string): Promise<{ ok: boolean; type_code: string; type_name: string }> {
    return http.patch(`/issues/${id}/type`, null, { params: { type_code } }).then(r => r.data)
  },

  resolveIssue(id: number, status_code: string, comment?: string, delay_to?: string, comment_public = true): Promise<{ ok: boolean; status_changed: boolean }> {
    return http.post(`/issues/${id}/resolve`, null, { params: { status_code, comment_public, ...(comment ? { comment } : {}), ...(delay_to ? { delay_to } : {}) } }).then(r => r.data)
  },

  updateIssueParameters(id: number, params: { address?: string; contact_person?: string; tel_person?: string }): Promise<{ ok: boolean; parameters: { name: string; value: string }[] }> {
    return http.post(`/issues/${id}/parameters`, params).then(r => r.data)
  },

  bulkAssign(issue_ids: number[], assignee_id: number): Promise<BulkResult> {
    return http.post('/issues/bulk/assignee', { issue_ids, assignee_id }).then(r => r.data)
  },

  bulkType(issue_ids: number[], type_code: string): Promise<BulkResult> {
    return http.post('/issues/bulk/type', { issue_ids, type_code }).then(r => r.data)
  },

  bulkStatus(issue_ids: number[], status_code: string, comment?: string, delay_to?: string, comment_public = true): Promise<BulkResult> {
    return http.post('/issues/bulk/status', { issue_ids, status_code, comment, delay_to, comment_public }).then(r => r.data)
  },

  chat(message: string): Promise<ChatResponse> {
    return http.post('/chat', { message }).then(r => r.data)
  },

  getTrainingStats(): Promise<{ count: number }> {
    return http.get('/issues/training/stats').then(r => r.data)
  },

  backfillTraining(dryRun: boolean, limit: number): Promise<{
    dry_run: boolean
    added: number
    scanned: number
    skipped_existing: number
    no_answer: number
    not_mileage: number
  }> {
    return http.post('/issues/training/backfill', null, { params: { dry_run: dryRun, limit } }).then(r => r.data)
  },

  getExtracted(id: number): Promise<ExtractedData> {
    return http.get(`/issues/${id}/extracted`).then(r => r.data)
  },

  // «Передать монтажнику»: готовые тексты КАЛЕНДАРЬ/МЕССЕНДЖЕР для копирования.
  installerExport(id: number): Promise<InstallerExport> {
    return http.get(`/issues/${id}/installer_export`).then(r => r.data)
  },

  // Петля обратной связи по качеству ИИ-разбора заявки.
  addAiFeedback(id: number, body: AiFeedbackBody): Promise<{ ok: boolean }> {
    return http.post(`/issues/${id}/ai_feedback`, body).then(r => r.data)
  },

  getAiFeedback(id: number): Promise<{ feedback: AiFeedback | null }> {
    return http.get(`/issues/${id}/ai_feedback`).then(r => r.data)
  },

  listAiFeedback(rating?: AiFeedbackRating): Promise<{ items: AiFeedbackListItem[]; count: number }> {
    return http.get('/issues/ai_feedback/list', { params: rating ? { rating } : undefined }).then(r => r.data)
  },

  resolveAiFeedback(id: number, resolved = true): Promise<{ ok: boolean; resolved: boolean }> {
    return http.post(`/issues/ai_feedback/${id}/resolve`, null, { params: { resolved } }).then(r => r.data)
  },

  // Личные сохранённые фильтры списка заявок.
  listSavedFilters(): Promise<SavedFilter[]> {
    return http.get('/saved-filters').then(r => r.data)
  },

  createSavedFilter(body: SavedFilterCreate): Promise<SavedFilter> {
    return http.post('/saved-filters', body).then(r => r.data)
  },

  updateSavedFilter(id: number, body: SavedFilterUpdate): Promise<SavedFilter> {
    return http.put(`/saved-filters/${id}`, body).then(r => r.data)
  },

  deleteSavedFilter(id: number): Promise<{ ok: boolean }> {
    return http.delete(`/saved-filters/${id}`).then(r => r.data)
  },
}

export interface BulkResult {
  ok: boolean
  succeeded: number
  failed: number
  results: { issue_id: number; ok: boolean }[]
}

export interface ExtractedData {
  plate: string | null
  date: string | null
  sheet_mileage_km: number | null
  declared_system_km: number | null
  body_text: string
  attachments_text: string
  attachments_count: number
}
