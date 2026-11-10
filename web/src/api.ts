import type { Evaluator, Model, Provider, Scan } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function request<T>(path: string, token = '', options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`/api/v1${path}`, { ...options, headers })
  if (response.status === 204) return undefined as T
  let payload: unknown
  try { payload = await response.json() } catch { throw new ApiError(response.status, '服务返回了非 JSON 响应，请检查后端或代理。') }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `请求失败（${response.status}）`
    throw new ApiError(response.status, message)
  }
  // The first-party Go API and these types form the internal contract.
  return payload as T
}

export type Connection = { vendor: string; base_url: string; api_key: string }
export const login = (key: string) => request<{ token: string; expires_at: string }>('/auth/login', '', { method: 'POST', body: JSON.stringify({ key }) })
export const logout = (token: string) => request<void>('/auth/logout', token, { method: 'POST' })
export const getProviders = (token: string, signal: AbortSignal) => request<{ providers: Provider[] }>('/providers', token, { signal })
export const getEvaluators = (token: string, signal: AbortSignal) => request<{ evaluators: Evaluator[] }>('/evaluators', token, { signal })
export const listScans = (token: string, signal: AbortSignal) => request<{ scans: Scan[] }>('/scans', token, { signal })
export const discoverModels = (token: string, input: Connection) => request<{ models: Model[] }>('/models/discover', token, { method: 'POST', body: JSON.stringify(input) })
export const createScan = (token: string, input: Connection & { scope: 'all' | 'selected'; models: string[]; evaluator: string }) => request<Scan>('/scans', token, { method: 'POST', body: JSON.stringify(input) })
export const getScan = (token: string, id: string, signal: AbortSignal) => request<Scan>(`/scans/${encodeURIComponent(id)}`, token, { signal })
