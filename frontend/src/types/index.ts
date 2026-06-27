export interface Issue {
  id: number
  external_id: number
  subject: string | null
  status: string | null
  priority: string | null
  company_name: string | null
  contact_name: string | null
  assignee_name: string | null
  created_at: string | null
  updated_at: string | null
  synced_at: string
  deadline_at: string | null
}

export interface ChatIssue {
  id: number
  external_id: number | null
  subject: string | null
  company_name: string | null
  status: string | null
  assignee_name: string | null
}

export interface ChatResponse {
  reply: string
  filters: Record<string, string>
  issues: ChatIssue[]
}

export interface Pagination {
  page: number
  limit: number
  total: number
  total_pages: number
}

export interface IssuesListResponse {
  data: Issue[]
  pagination: Pagination
}

export interface Analysis {
  id: number
  mileage_from_sheet: number | null
  mileage_from_system: number | null
  discrepancy_percent: number | null
  ai_suggestion: string | null
  recommendation: string | null
  created_at: string
}

export interface OkdeskDetail {
  description: string | null
  source: string | null
  deadline_at: string | null
  completed_at: string | null
  planned_reaction_at: string | null
  reacted_at: string | null
  delayed_to: string | null
  spent_time_total: number | null
  type_name: string | null
  type_code: string | null
  author_name: string | null
  service_object_name: string | null
  parent_id: number | null
  child_ids: number[]
  parameters: { name: string; value: string }[]
}

export interface IssueDetail {
  issue: Issue
  okdesk_detail: OkdeskDetail
  latest_analysis: Analysis | null
}

export interface Comment {
  id: number
  author: string
  content: string | null
  created_at: string | null
  is_internal: boolean | null
  is_public?: boolean
  author_kind?: string
}

export type StatusCode = 'opened' | 'in_progress' | 'resolved' | 'closed' | string

export interface AutomationParsed {
  plate: string | null
  date: string | null
  sheet_mileage_km: number | null
  declared_system_km: number | null
  llm_extracted?: boolean
}

export interface AutomationTelemetry {
  object_id: number | null
  object_name: string | null
  system_mileage_km: number | null
  max_speed: number | null
  move_time_min: number | null
  packets: number
  avg_sat: number | null
  low_sat_ratio: number | null
  min_power_v: number | null
  avg_power_v: number | null
  power_off_ratio: number | null
  max_gap_min: number | null
  zero_coord_moving_ratio: number | null
  max_speed_packet: number | null
  speed_spike_count: number
  teleport_jumps: number
  max_implied_kmh: number | null
  flags: string[]
}

export interface AutomationResult {
  parsed: AutomationParsed
  telemetry: AutomationTelemetry
  category: string
  confidence: number
  draft_answer: string
  reasoning: string
  needs_review: boolean
  needs_remote_diagnostics?: boolean
  spec_vehicle?: boolean
  error: string | null
}

export interface TrackPoint {
  t: number
  lat: number | null
  lng: number | null
  speed: number
  sat: number
  pwr: number | null
}

export interface TrackObjectStatus {
  online?: boolean
  last_time?: number
  speed?: number
  sat?: number
}

export interface TrackData {
  parsed: AutomationParsed
  object_id?: number
  object_name?: string
  imei?: string | null
  phone?: string | null
  status?: TrackObjectStatus
  range_from?: string
  range_to?: string
  total_packets?: number
  points: TrackPoint[]
  teleports?: number[]
  error?: string
}

export interface BatchObject {
  file: string
  plate: string | null
  date: string | null
  sheet_mileage_km: number | null
  declared_system_km?: number | null
  system_mileage_km: number | null
  address?: string | null
  flags: string[]
  teleport_jumps: number
  verdict: string
  verdict_edited?: boolean
  spec_vehicle?: boolean
}

export interface BatchResult {
  total: number
  jamming_count: number
  ok_count: number
  is_aggregate?: boolean
  objects: BatchObject[]
}

// Этап 2: suggested placeholder->value map for dynamic templates.
export interface TemplateValues {
  values: Record<string, string>
}

export interface IssueAttachment {
  id: number
  name: string | null
  size: number | null
  is_public: boolean | null
  kind: string
  extractable: boolean
}

export interface Template {
  id: number
  name: string
  content: string
  category_id: number
  category_name: string | null
  category_color: string | null
  usage_count: number
  is_favorite: boolean
  is_dynamic: boolean
  /** NULL = shared (visible to everyone); a username = personal (owner only). */
  user_id: string | null
}

export interface TemplateCategory {
  id: number
  name: string
  color: string | null
}

export interface TemplateCreate {
  name: string
  content: string
  category_id?: number | null
  is_dynamic?: boolean
  is_favorite?: boolean
  /** When true the template is owned by the current user (personal). */
  is_personal?: boolean
}

export interface TemplateUpdate {
  name?: string
  content?: string
  category_id?: number | null
  is_dynamic?: boolean
  is_favorite?: boolean
  active?: boolean
}

// Петля обратной связи по качеству ИИ-разбора заявки.
export type AiFeedbackRating = 'good' | 'bad'
export type AiFeedbackErrorKind = 'wrong_verdict' | 'wrong_plate' | 'wrong_date' | 'wrong_mileage' | 'other'

/** Тело запроса POST /issues/{id}/ai_feedback */
export interface AiFeedbackBody {
  rating: AiFeedbackRating
  error_kind?: AiFeedbackErrorKind
  comment?: string
  correct_category?: string
}

/** Сохранённая оценка ИИ-разбора (GET /issues/{id}/ai_feedback → feedback). */
export interface AiFeedback {
  rating: AiFeedbackRating
  error_kind: AiFeedbackErrorKind | null
  comment: string | null
  ai_category: string | null
  correct_category: string | null
  created_by: string | null
  created_at: string | null
}

/** Элемент списка GET /issues/ai_feedback/list */
export interface AiFeedbackListItem {
  issue_external_id: number
  rating: AiFeedbackRating
  error_kind: AiFeedbackErrorKind | null
  comment: string | null
  ai_category: string | null
  correct_category: string | null
  created_by: string | null
  created_at: string | null
}
