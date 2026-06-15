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
}

export type StatusCode = 'opened' | 'in_progress' | 'resolved' | 'closed' | string

export interface AutomationParsed {
  plate: string | null
  date: string | null
  sheet_mileage_km: number | null
  declared_system_km: number | null
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
  system_mileage_km: number | null
  address?: string | null
  flags: string[]
  teleport_jumps: number
  verdict: string
}

export interface BatchResult {
  total: number
  jamming_count: number
  ok_count: number
  objects: BatchObject[]
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
}
