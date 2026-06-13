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
