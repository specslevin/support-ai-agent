export interface Issue {
  id: number
  external_id: number
  subject: string | null
  status: string | null
  priority: string | null
  company_name: string | null
  contact_name: string | null
  created_at: string | null
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

export interface IssueDetail {
  issue: Issue
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
