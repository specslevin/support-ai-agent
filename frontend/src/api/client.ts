import axios from 'axios'
import type { IssuesListResponse, IssueDetail, Comment, Analysis, Template } from '../types'

const http = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
})

export interface IssuesQuery {
  status?: string
  company?: string
  search?: string
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
}
