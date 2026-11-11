import { cleanupLegacyScans, readLocal, writeLocal, mergeLocal, type LocalProjectState } from './data/local'
import { readSavedServices, writeSavedServices, type SavedModelService, type ServiceSource } from './features/scans/savedServices'
import type { BenchCatalog, BenchInput, BenchJob, BenchReadiness } from './features/terminalbench/types'
import type { BatchRun, InspectionPlan, InspectionProject, ProjectInput } from './features/inspection/types'
import type { Evaluator, Model, Provider, Scan } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export type WorkspaceMode = 'local' | 'cloud'
export type ExecutionLocation = 'local' | 'cloud'
export type APIClient = { mode: WorkspaceMode; token: string }

async function request<T>(path: string, client: APIClient, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (client.mode === 'local' && !client.token) throw new ApiError(428, '请先下载并连接本机执行器。本地请求不会转发到云端。')
  if (client.token) headers.set('Authorization', `Bearer ${client.token}`)
  const response = await fetch(`${client.mode === 'local' ? localBase : ''}/api/v1${path}`, { ...options, headers })
  if (response.status === 204) { if (client.mode === 'local' && path.startsWith('/inspection')) await persistLocalProjects(client); return undefined as T }
  let payload: unknown
  try { payload = await response.json() } catch { throw new ApiError(response.status, '服务返回了非 JSON 响应，请检查后端或代理。') }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `请求失败（${response.status}）`
    throw new ApiError(response.status, message)
  }
  if (client.mode === 'local' && path.startsWith('/inspection')) await persistLocalProjects(client)
  return payload as T
}

export type Connection = { service_id?: string; vendor: string; service_name: string; protocol: 'chat_completions' | 'responses' | 'messages'; base_url: string; api_key: string }
export type User = { id: number; username: string }
export const login = (username: string, password: string) => request<{ token: string; user: User; expires_at: string }>('/auth/login', { mode: 'cloud', token: '' }, { method: 'POST', body: JSON.stringify({ username, password }) })
export const logout = (token: APIClient) => request<void>('/auth/logout', token, { method: 'POST' })
export const getUser = (token: APIClient) => request<User>('/auth/me', token)
export const getProviders = (_token: APIClient, signal: AbortSignal) => getCatalog(signal).then((catalog) => ({ providers: catalog.providers }))
export const getEvaluators = (_token: APIClient, signal: AbortSignal) => getCatalog(signal).then((catalog) => ({ evaluators: catalog.evaluators }))

function usableScan(item: Scan) {
  return Array.isArray(item.models) && item.models.every((model) => Array.isArray(model.report?.checks))
}

async function listScansForClient(token: APIClient, signal: AbortSignal): Promise<Scan[]> {
  if (token.mode === 'local' && !token.token) return (await cleanupLegacyScans()).map((item) => ({ ...item, source: 'local' as const }))
  const response = await request<{ scans: Scan[] }>('/scans', token, { signal })
  const validResponse = response.scans.filter(usableScan).map((item) => ({ ...item, source: token.mode }))
  if (token.mode === 'cloud') return validResponse
  const active = new Set(validResponse.map((item) => item.id))
  const previous = (await cleanupLegacyScans()).map((item) => ({ ...item, source: 'local' as const }))
  const interrupted = previous.filter((item) => !active.has(item.id) && ['pending', 'running'].includes(item.status)).map((item): Scan => ({ ...item, source: 'local', status: 'failed', error: '本机执行会话已结束，任务无法恢复' }))
  return mergeLocal('scans', [...interrupted, ...validResponse])
}

export async function listScans(token: APIClient, signal: AbortSignal, peers?: { local?: APIClient; cloud?: APIClient }) {
  const clients = [token, peers?.local, peers?.cloud].filter((item): item is APIClient => Boolean(item && (item.mode === 'local' || item.token)))
  const unique = clients.filter((item, index, all) => all.findIndex((candidate) => candidate.mode === item.mode && candidate.token === item.token) === index)
  const results = await Promise.all(unique.map((item) => listScansForClient(item, signal)))
  const byKey = new Map<string, Scan>()
  results.flat().forEach((item) => byKey.set(`${item.source || token.mode}:${item.id}`, item))
  return { scans: [...byKey.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)) }
}
export const discoverModels = (token: APIClient, input: Connection) => request<{ models: Model[] }>('/models/discover', token, { method: 'POST', body: JSON.stringify(input) })
export const createScan = async (token: APIClient, input: Connection & { scope: 'all' | 'selected'; models: string[]; evaluator: string; evaluator_options?: Record<string, unknown> }) => { const item = { ...(await request<Scan>('/scans', token, { method: 'POST', body: JSON.stringify(input) })), source: token.mode as 'local' | 'cloud' }; if (token.mode === 'local') await mergeLocal('scans', [item]); return item }
export const getScan = async (token: APIClient, id: string, signal: AbortSignal) => { const item = { ...(await request<Scan>(`/scans/${encodeURIComponent(id)}`, token, { signal })), source: token.mode as 'local' | 'cloud' }; if (!usableScan(item)) throw new ApiError(502, '扫描结果数据已失效，请重新巡检'); if (token.mode === 'local') await mergeLocal('scans', [item]); return item }

export const getInspectionProjects = async (token: APIClient, signal?: AbortSignal) => token.mode === 'local' && !token.token ? { projects: Object.values((await readLocal<LocalProjectState>('inspection'))?.projects || {}).map((item) => ({ ...item.view, busy: false })) } : request<{ projects: InspectionProject[] }>('/inspection/projects', token, { signal })
export const saveInspectionProject = (token: APIClient, input: ProjectInput, id?: string) => request<InspectionProject>(`/inspection/projects${id ? `/${encodeURIComponent(id)}` : ''}`, token, { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) })
export const deleteInspectionProject = (token: APIClient, id: string) => request<void>(`/inspection/projects/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
export const syncInspectionProject = (token: APIClient, id: string, options?: { import_keys: boolean; two_factor_code: string }) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/sync`, token, { method: 'POST', body: options ? JSON.stringify(options) : undefined })
export const importInspectionKeys = (token: APIClient, id: string, channel_ids: string[], two_factor_code: string) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/keys`, token, { method: 'POST', body: JSON.stringify({ channel_ids, two_factor_code }) })
export const saveInspectionPlan = (token: APIClient, id: string, input: InspectionPlan) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/plan`, token, { method: 'PUT', body: JSON.stringify(input) })
export const saveInspectionChannelProtocol = (token: APIClient, id: string, channelID: string, protocol: string) => request<InspectionProject>(`/inspection/projects/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelID)}/protocol`, token, { method: 'PUT', body: JSON.stringify({ protocol }) })
export const runInspectionProject = (token: APIClient, id: string) => request<BatchRun>(`/inspection/projects/${encodeURIComponent(id)}/run`, token, { method: 'POST' })
export const runInspectionBatch = (token: APIClient, project_ids: string[]) => request<{ outcomes: Array<{ project_id: string; run_id?: string; error?: string }> }>('/inspection/batch-run', token, { method: 'POST', body: JSON.stringify({ project_ids }) })
export const getInspectionRuns = async (token: APIClient, signal?: AbortSignal) => token.mode === 'local' && !token.token ? { runs: (await readLocal<LocalProjectState>('inspection'))?.runs || [] } : request<{ runs: BatchRun[] }>('/inspection/runs', token, { signal })

export const getBenchCatalog = (_token: APIClient, signal?: AbortSignal) => getCatalog(signal).then((catalog) => catalog.terminal_bench)
export const getBenchReadiness = (token: APIClient, signal?: AbortSignal) => request<BenchReadiness>('/terminal-bench/readiness', token, { signal })
export async function getBenchJobs(token: APIClient, signal?: AbortSignal) {
  if (token.mode === 'local' && !token.token) return { jobs: await readLocal<BenchJob[]>('bench-jobs') || [] }
  const response = await request<{ jobs: BenchJob[] }>('/terminal-bench/jobs', token, { signal })
  const tagged = response.jobs.map((item) => ({ ...item, source: token.mode as 'local' | 'cloud' }))
  if (token.mode === 'cloud') return { jobs: tagged }
  const active = new Set(tagged.map((item) => item.id))
  const previous = await readLocal<BenchJob[]>('bench-jobs') || []
  const interrupted = previous.filter((item) => !active.has(item.id) && ['pending', 'running', 'cancelling'].includes(item.status)).map((item) => ({ ...item, status: 'interrupted', error: '本机执行会话已结束' }))
  return { jobs: await mergeLocal('bench-jobs', [...interrupted, ...tagged]) }
}
export const createBenchJob = async (token: APIClient, input: BenchInput) => { const item = { ...(await request<BenchJob>('/terminal-bench/jobs', token, { method: 'POST', body: JSON.stringify(input) })), source: token.mode as 'local' | 'cloud' }; if (token.mode === 'local') await mergeLocal('bench-jobs', [item]); return item }
export const cancelBenchJob = (token: APIClient, id: string) => request<void>(`/terminal-bench/jobs/${encodeURIComponent(id)}/cancel`, token, { method: 'POST' })

export const localBase = 'http://127.0.0.1:9002'
export async function probeLocalRuntime() {
  try {
    const response = await fetch(`${localBase}/healthz`, { headers: { Accept: 'application/json' } })
    return response.ok
  } catch {
    return false
  }
}
const cloudPublic: APIClient = { mode: 'cloud', token: '' }
export const getCatalog = (signal?: AbortSignal) => request<{ providers: Provider[]; evaluators: Evaluator[]; terminal_bench: BenchCatalog }>('/catalog', cloudPublic, { signal })
let snapshotQueue: Promise<void> = Promise.resolve()
function persistLocalProjects(client: APIClient) {
  const operation = snapshotQueue.catch(() => {}).then(async () => {
    const response = await fetch(`${localBase}/api/v1/local/state`, { headers: { Authorization: `Bearer ${client.token}` } })
    if (!response.ok) throw new Error('本地项目状态读取失败，尚未保存到浏览器')
    await writeLocal('inspection', await response.json())
  })
  snapshotQueue = operation
  return operation
}
export async function connectLocal() {
  const state = await readLocal<LocalProjectState>('inspection')
  const response = await fetch(`${localBase}/api/v1/local/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '本地连接失败')
  return result as { token: string }
}
export const dependencyState = (client: APIClient) => request<{ running: boolean; error: string }>('/local/dependencies', client)
export const installHarbor = (client: APIClient) => request<{ running: boolean; error: string }>('/local/dependencies', client, { method: 'POST' })
export const removeHarbor = (client: APIClient) => request<void>('/local/dependencies', client, { method: 'DELETE' })
export const disconnectLocal = (client: APIClient) => request<void>('/local/session', client, { method: 'DELETE' })

function markService(service: SavedModelService, source: ServiceSource): SavedModelService {
  return { ...service, source, api_key: source === 'cloud' ? '' : service.api_key, has_key: source === 'cloud' ? service.has_key : Boolean(service.api_key) }
}
export async function readModelServices(client: APIClient) {
  const local = readSavedServices().map((service) => markService(service, 'local'))
  if (client.mode !== 'cloud') return local
  const response = await request<{ services: SavedModelService[] }>('/model-services', client)
  const cloud = response.services.map((service) => markService(service, 'cloud'))
  return [...local, ...cloud]
}
export async function saveModelServices(client: APIClient, services: SavedModelService[]) {
  const local = services.filter((service) => service.source === 'local').map((service) => ({ ...service, source: 'local' as const }))
  writeSavedServices(local)
  if (client.mode === 'local') return local
  const cloudInput = services.filter((service) => service.source === 'cloud').map(({ source: _source, has_key: _hasKey, ...service }) => service)
  const response = await request<{ services: SavedModelService[] }>('/model-services', client, { method: 'PUT', body: JSON.stringify(cloudInput) })
  return [...local, ...response.services.map((service) => markService(service, 'cloud'))]
}
