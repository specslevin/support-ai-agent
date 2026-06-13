import axios from 'axios'
import type { IssuesListResponse, IssueDetail, Comment, Analysis } from '../types'

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

  addComment(id: number, text: string): Promise<{ ok: boolean }> {
    return http.post(`/issues/${id}/comments`, null, { params: { text } }).then(r => r.data)
  },

  submitAnalysis(id: number, mileage_from_sheet: number, notes?: string): Promise<Analysis> {
    return http.post(`/issues/${id}/analysis`, { mileage_from_sheet, notes }).then(r => r.data)
  },

  refreshCache(): Promise<{ ok: boolean; synced: number }> {
    return http.get('/issues/cache/refresh').then(r => r.data)
  },
}
