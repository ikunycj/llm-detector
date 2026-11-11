import type { BenchCatalog, BenchInput, BenchJob, BenchReadiness } from './features/terminalbench/types'
import type { BatchRun, InspectionPlan, InspectionProject, ProjectInput } from './features/inspection/types'
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

export type Connection = { vendor: string; service_name: string; protocol: 'chat_completions' | 'messages'; base_url: string; api_key: string }
export const login = (key: string) => request<{ token: string; expires_at: string }>('/auth/login', '', { method: 'POST', body: JSON.stringify({ key }) })
export const logout = (token: string) => request<void>('/auth/logout', token, { method: 'POST' })
export const getProviders = (token: string, signal: AbortSignal) => request<{ providers: Provider[] }>('/providers', token, { signal })
export const getEvaluators = (token: string, signal: AbortSignal) => request<{ evaluators: Evaluator[] }>('/evaluators', token, { signal })
export const listScans = (token: string, signal: AbortSignal) => request<{ scans: Scan[] }>('/scans', token, { signal })
export const discoverModels = (token: string, input: Connection) => request<{ models: Model[] }>('/models/discover', token, { method: 'POST', body: JSON.stringify(input) })
export const createScan = (token: string, input: Connection & { scope: 'all' | 'selected'; models: string[]; evaluator: string; evaluator_options?: Record<string, unknown> }) => request<Scan>('/scans', token, { method: 'POST', body: JSON.stringify(input) })
export const getScan = (token: string, id: string, signal: AbortSignal) => request<Scan>(`/scans/${encodeURIComponent(id)}`, token, { signal })

export const getInspectionProjects = (token: string, signal?: AbortSignal) => request<{ projects: InspectionProject[] }>('/inspection/projects', token, { signal })
export const saveInspectionProject = (token: string, input: ProjectInput, id?: string) => request<InspectionProject>(`/inspection/projects${id ? `/${encodeURIComponent(id)}` : ''}`, token, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) })
export const deleteInspectionProject = (token: string, id: string) => request<void>(`/inspection/projects/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
export const syncInspectionProject = (token: string, id: string, options?: { import_keys: boolean; two_factor_code: string }) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/sync`, token, { method: 'POST', body: options ? JSON.stringify(options) : undefined })
export const importInspectionKeys = (token: string, id: string, channel_ids: string[], two_factor_code: string) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/keys`, token, { method: 'POST', body: JSON.stringify({ channel_ids, two_factor_code }) })
export const saveInspectionPlan = (token: string, id: string, input: InspectionPlan) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/plan`, token, { method: 'PUT', body: JSON.stringify(input) })
export const saveInspectionChannelProtocol = (token: string, id: string, channelID: string, protocol: string) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelID)}/protocol`, token, { method: 'PUT', body: JSON.stringify({ protocol }) })
export const runInspectionProject = (token: string, id: string) => request<BatchRun>(`/inspection/projects/${encodeURIComponent(id)}/run`, token, { method: 'POST' })
export const runInspectionBatch = (token: string, project_ids: string[]) => request<{ outcomes: Array<{ project_id: string; run_id?: string; error?: string }> }>('/inspection/batch-run', token, { method: 'POST', body: JSON.stringify({ project_ids }) })
export const getInspectionRuns = (token: string, signal?: AbortSignal) => request<{ runs: BatchRun[] }>('/inspection/runs', token, { signal })

export const getBenchCatalog = (token: string, signal?: AbortSignal) => request<BenchCatalog>('/terminal-bench/catalog', token, { signal })
export const getBenchReadiness = (token: string, signal?: AbortSignal) => request<BenchReadiness>('/terminal-bench/readiness', token, { signal })
export const getBenchJobs = (token: string, signal?: AbortSignal) => request<{ jobs: BenchJob[] }>('/terminal-bench/jobs', token, { signal })
export const createBenchJob = (token: string, input: BenchInput) => request<BenchJob>('/terminal-bench/jobs', token, { method: 'POST', body: JSON.stringify(input) })
export const cancelBenchJob = (token: string, id: string) => request<void>(`/terminal-bench/jobs/${encodeURIComponent(id)}/cancel`, token, { method: 'POST' })
