import axios from 'axios'
import type { IssuesListResponse, IssueDetail, Comment, Analysis, Template, AutomationResult, TrackData, IssueAttachment, BatchResult } from '../types'

const http = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
})

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

  automateIssue(id: number): Promise<AutomationResult> {
    return http.post(`/issues/${id}/automate`).then(r => r.data)
  },

  automateBatch(id: number): Promise<BatchResult> {
    return http.post(`/issues/${id}/automate_batch`).then(r => r.data)
  },

  createChildren(id: number, objects: import('../types').BatchObject[]): Promise<{ ok: boolean; created: number; failed: number; results: { plate: string; issue_id?: number; ok: boolean }[] }> {
    const payload = objects.map(o => ({
      plate: o.plate, date: o.date, address: o.address,
      sheet_mileage_km: o.sheet_mileage_km, system_mileage_km: o.system_mileage_km,
    }))
    return http.post(`/issues/${id}/create_children`, { objects: payload }).then(r => r.data)
  },

  getTrack(id: number): Promise<TrackData> {
    return http.get(`/issues/${id}/track`).then(r => r.data)
  },

  listAttachments(id: number): Promise<IssueAttachment[]> {
    return http.get(`/issues/${id}/attachments`).then(r => r.data)
  },

  attachmentUrl(id: number, attId: number): string {
    return `/api/v1/issues/${id}/attachments/${attId}/download`
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

  listIssueTypes(): Promise<{ code: string; name: string }[]> {
    return http.get('/issue-types').then(r => r.data)
  },

  changeIssueType(id: number, type_code: string): Promise<{ ok: boolean; type_code: string; type_name: string }> {
    return http.patch(`/issues/${id}/type`, null, { params: { type_code } }).then(r => r.data)
  },

  resolveIssue(id: number, status_code: string, comment: string, delay_to?: string, comment_public = true): Promise<{ ok: boolean; status_changed: boolean }> {
    return http.post(`/issues/${id}/resolve`, null, { params: { status_code, comment, comment_public, ...(delay_to ? { delay_to } : {}) } }).then(r => r.data)
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
}

export interface BulkResult {
  ok: boolean
  succeeded: number
  failed: number
  results: { issue_id: number; ok: boolean }[]
}
