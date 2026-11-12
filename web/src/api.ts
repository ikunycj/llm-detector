import { cleanupLegacyScans, readLocal, writeLocal, mergeLocal, type LocalProjectState } from './data/local'
import { sourceID, type APIClient, type SourceID } from './data/sources'
import { readSavedServices, writeSavedServices, type SavedModelService } from './features/scans/savedServices'
import type { BenchCatalog, BenchInput, BenchJob, BenchReadiness } from './features/terminalbench/types'
import type { BatchRun, InspectionPlan, InspectionProject, ProjectInput } from './features/inspection/types'
import type { Evaluator, Model, Provider, Scan } from './types'
export type { APIClient } from './data/sources'
export type ExecutionLocation = SourceID
export type User = { id: number; username: string }
export type CloudSession = { token: string; user: User; expires_at: string }
export type Connection = {
  service_id?: string
  vendor: string
  service_name: string
  protocol: 'chat_completions' | 'responses' | 'messages'
  base_url: string
  api_key: string
}
export const localBase = 'http://127.0.0.1:9002'
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public source?: SourceID,
  ) {
    super(message)
  }
}
export async function request<T>(path: string, client: APIClient, options: RequestInit = {}): Promise<T> {
  if (client.mode === 'local' && !client.token) throw new ApiError(428, '请先连接本机 Worker。', 'local')
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (client.token) headers.set('Authorization', `Bearer ${client.token}`)
  const base = client.mode === 'local' ? localBase : client.mode === 'worker' ? client.baseURL : ''
  const signal =
    options.method && options.method !== 'GET'
      ? options.signal
      : AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15000)])
  const response = await fetch(`${base}/api/v1${path}`, { ...options, signal, headers, redirect: 'error' })
  if (response.status === 204) return undefined as T
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError(response.status, '服务返回了非 JSON 响应，请检查地址、跨域配置或代理。', sourceID(client))
  }
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `请求失败（${response.status}）`
    throw new ApiError(response.status, message, sourceID(client))
  }
  return payload as T
}
const publicCloud: APIClient = { mode: 'cloud', token: '' }
export const login = (key: string) =>
  request<CloudSession>('/auth/login', publicCloud, { method: 'POST', body: JSON.stringify({ key }) })
export const logout = (client: APIClient) => request<void>('/auth/logout', client, { method: 'POST' })
export const getUser = (client: APIClient) => request<User>('/auth/me', client)
export const getCatalog = (signal?: AbortSignal) =>
  request<{ providers: Provider[]; evaluators: Evaluator[]; terminal_bench: BenchCatalog }>('/catalog', publicCloud, {
    signal,
  })
export const getProviders = (_client: APIClient, signal: AbortSignal) =>
  getCatalog(signal).then((c) => ({ providers: c.providers }))
export const getEvaluators = (_client: APIClient, signal: AbortSignal) =>
  getCatalog(signal).then((c) => ({ evaluators: c.evaluators }))
export const getBenchCatalog = (_client: APIClient, signal?: AbortSignal) =>
  getCatalog(signal).then((c) => c.terminal_bench)
export async function checkWorker(client: APIClient) {
  const info = await request<{ protocol_version: number }>('/worker/info', client, {
    signal: AbortSignal.timeout(8000),
  })
  if (info.protocol_version !== 1) throw new Error('该地址不是支持当前协议的 LLM Detector Worker')
}
export async function probeLocalRuntime() {
  try {
    return (await fetch(`${localBase}/healthz`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}
export async function connectLocal() {
  const state = await readLocal<LocalProjectState>('inspection')
  const response = await fetch(`${localBase}/api/v1/local/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(10000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '本机 Worker 连接失败')
  return result as { token: string }
}
export const dependencyState = (client: APIClient) =>
  request<{ running: boolean; error: string }>('/local/dependencies', client)
export const installHarbor = (client: APIClient) =>
  request<{ running: boolean; error: string }>('/local/dependencies', client, { method: 'POST' })
export const removeHarbor = (client: APIClient) => request<void>('/local/dependencies', client, { method: 'DELETE' })
export const disconnectLocal = (client: APIClient) => request<void>('/local/session', client, { method: 'DELETE' })

export async function readModelServices(client: APIClient) {
  if (client.mode === 'local') return readSavedServices()
  const { services } = await request<{ services: SavedModelService[] }>('/model-services', client)
  return services.map((item) => ({ ...item, source: sourceID(client) }))
}
function wireService(item: SavedModelService) {
  const { id, name, vendor, protocol, base_url, api_key, scope, models, updated_at } = item
  return { id, name, vendor, service_name: name, protocol, base_url, api_key, scope, models, updated_at }
}
export async function saveModelServices(client: APIClient, services: SavedModelService[]) {
  if (client.mode === 'local') {
    writeSavedServices(services)
    return services
  }
  const result = await request<{ services: SavedModelService[] }>('/model-services', client, {
    method: 'PUT',
    body: JSON.stringify(services.map(wireService)),
  })
  return result.services.map((item) => ({ ...item, source: sourceID(client) }))
}
export async function transferModelService(client: APIClient, service: SavedModelService) {
  if (client.mode === 'local') return service
  return request<SavedModelService>('/model-services/transfer', client, {
    method: 'POST',
    body: JSON.stringify({ id: service.id }),
  })
}
export async function connectionFor(
  service: SavedModelService,
  owner: APIClient,
  target: APIClient,
): Promise<Connection> {
  if (sourceID(owner) === sourceID(target) && target.mode !== 'local')
    return {
      service_id: service.id,
      vendor: service.vendor,
      service_name: service.name,
      protocol: service.protocol,
      base_url: service.base_url,
      api_key: '',
    }
  const config = service.api_key ? service : await transferModelService(owner, service)
  return {
    vendor: config.vendor,
    service_name: config.name,
    protocol: config.protocol,
    base_url: config.base_url,
    api_key: config.api_key,
  }
}
export async function discoverModels(client: APIClient, input: Connection) {
  if (client.mode !== 'local')
    return request<{ models: Model[] }>('/models/discover', client, { method: 'POST', body: JSON.stringify(input) })
  const headers: Record<string, string> =
    input.protocol === 'messages'
      ? {
          'x-api-key': input.api_key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        }
      : { Authorization: `Bearer ${input.api_key}` }
  const root = input.base_url.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '')
  const url = `${root}${/\/v\d+$/.test(root) ? '' : '/v1'}/models`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000), redirect: 'error' })
  if (!response.ok) throw new Error(`模型发现失败（HTTP ${response.status}）`)
  const payload: unknown = await response.json()
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('data' in payload) ||
    !Array.isArray(payload.data) ||
    !payload.data.every((item) => item && typeof item.id === 'string')
  )
    throw new Error('模型发现接口返回格式无效')
  return { models: payload.data.map((item): Model => ({ id: item.id, name: item.id })) }
}

export async function listScans(client: APIClient, signal?: AbortSignal) {
  const source = sourceID(client)
  if (client.mode === 'local') {
    const stored = await cleanupLegacyScans()
    if (!client.token) return { scans: stored.map((item) => ({ ...item, source })) }
    const response = await request<{ scans: Scan[] }>('/scans', client, { signal })
    return { scans: (await mergeLocal('scans', response.scans)).map((item) => ({ ...item, source })) }
  }
  const response = await request<{ scans: Scan[] }>('/scans', client, { signal })
  return { scans: response.scans.map((item) => ({ ...item, source })) }
}
export type ScanInput = Connection & {
  scope: 'all' | 'selected'
  models: string[]
  evaluator: string
  evaluator_options?: Record<string, unknown>
}
export async function createScan(client: APIClient, input: ScanInput) {
  const item = {
    ...(await request<Scan>('/scans', client, { method: 'POST', body: JSON.stringify(input) })),
    source: sourceID(client),
  }
  if (client.mode === 'local') await mergeLocal('scans', [item])
  return item
}
export async function getScan(client: APIClient, id: string, signal?: AbortSignal) {
  if (client.mode === 'local' && id.startsWith('browser-')) {
    const item = (await cleanupLegacyScans()).find((scan) => scan.id === id)
    if (!item) throw new Error('浏览器任务不存在')
    return { ...item, source: 'local' as const }
  }
  const item = {
    ...(await request<Scan>(`/scans/${encodeURIComponent(id)}`, client, { signal })),
    source: sourceID(client),
  }
  if (client.mode === 'local') await mergeLocal('scans', [item])
  return item
}
export const getBenchReadiness = (client: APIClient, signal?: AbortSignal) =>
  request<BenchReadiness>('/terminal-bench/readiness', client, { signal })
export async function getBenchJobs(client: APIClient, signal?: AbortSignal) {
  const source = sourceID(client)
  if (client.mode === 'local' && !client.token)
    return { jobs: ((await readLocal<BenchJob[]>('bench-jobs')) || []).map((item) => ({ ...item, source })) }
  const { jobs } = await request<{ jobs: BenchJob[] }>('/terminal-bench/jobs', client, { signal })
  return {
    jobs: (client.mode === 'local' ? await mergeLocal('bench-jobs', jobs) : jobs).map((item) => ({ ...item, source })),
  }
}
export async function createBenchJob(client: APIClient, input: BenchInput) {
  const item = {
    ...(await request<BenchJob>('/terminal-bench/jobs', client, { method: 'POST', body: JSON.stringify(input) })),
    source: sourceID(client),
  }
  if (client.mode === 'local') await mergeLocal('bench-jobs', [item])
  return item
}
export const cancelBenchJob = (client: APIClient, id: string) =>
  request<void>(`/terminal-bench/jobs/${encodeURIComponent(id)}/cancel`, client, { method: 'POST' })

export type ProjectTransfer = LocalProjectState['projects'][string]
export async function localProjectState(): Promise<LocalProjectState> {
  return (await readLocal<LocalProjectState>('inspection')) || { version: 1, projects: {}, runs: [] }
}
// Snapshot after a local mutation or an active run, so credentials stay in the browser.
let snapshotQueue: Promise<void> = Promise.resolve()
async function saveLocalSnapshot(client: APIClient) {
  if (client.mode !== 'local') return
  const operation = snapshotQueue
    .catch(() => {})
    .then(async () => {
      await writeLocal('inspection', await request<LocalProjectState>('/local/state', client))
    })
  snapshotQueue = operation
  return operation
}
export async function getInspectionProjects(
  client: APIClient,
  signal?: AbortSignal,
): Promise<{ projects: InspectionProject[] }> {
  if (client.mode === 'local' && !client.token)
    return {
      projects: Object.values((await localProjectState()).projects).map((item) => ({
        ...item.view,
        source: 'local' as const,
        busy: false,
      })),
    }
  const { projects } = await request<{ projects: InspectionProject[] }>('/inspection/projects', client, { signal })
  return { projects: projects.map((item) => ({ ...item, source: sourceID(client) })) }
}
export async function getInspectionRuns(client: APIClient, signal?: AbortSignal): Promise<{ runs: BatchRun[] }> {
  if (client.mode === 'local' && !client.token)
    return { runs: (await localProjectState()).runs.map((item) => ({ ...item, source: 'local' as const })) }
  const { runs } = await request<{ runs: BatchRun[] }>('/inspection/runs', client, { signal })
  await saveLocalSnapshot(client)
  return {
    runs: runs.map((item) => ({
      ...item,
      source: sourceID(client),
      items: item.items.map((row) => ({
        ...row,
        result: row.result ? { ...row.result, source: sourceID(client) } : undefined,
      })),
    })),
  }
}
export async function exportProject(client: APIClient, project: InspectionProject) {
  if (client.mode === 'local') {
    if (client.token) await saveLocalSnapshot(client)
    const item = (await localProjectState()).projects[project.id]
    if (!item) throw new Error('浏览器项目不存在')
    return item
  }
  return request<ProjectTransfer>(`/inspection/projects/${encodeURIComponent(project.id)}/transfer`, client, {
    method: 'POST',
  })
}
export async function copyProject(from: APIClient, project: InspectionProject, to: APIClient) {
  if (sourceID(from) === sourceID(to)) return project
  const snapshot = await exportProject(from, project)
  const { source: _source, ...view } = snapshot.view
  if (to.mode === 'local' && !to.token) {
    const state = await localProjectState()
    const copied: InspectionProject = {
      ...view,
      id: `project-${crypto.randomUUID()}`,
      busy: false,
      next_run_at: undefined,
      plan: { ...view.plan, enabled: false },
    }
    state.projects[copied.id] = { ...snapshot, view: copied }
    await writeLocal('inspection', state)
    return { ...copied, source: 'local' as const }
  }
  const copied = await request<InspectionProject>('/inspection/projects/import', to, {
    method: 'POST',
    body: JSON.stringify({ ...snapshot, view }),
  })
  await saveLocalSnapshot(to)
  return { ...copied, source: sourceID(to) }
}
async function projectMutation<T>(client: APIClient, path: string, options: RequestInit): Promise<T> {
  const result = await request<T>(path, client, options)
  await saveLocalSnapshot(client)
  return result
}
export async function saveInspectionProject(client: APIClient, input: ProjectInput, id?: string) {
  if (client.mode === 'local' && !client.token) {
    const state = await localProjectState()
    const previous = id ? state.projects[id] : undefined
    if (input.user_id <= 0) throw new Error('账号解析需要本机 Worker，或在高级配置中填写 User ID')
    const access_token = input.access_token || previous?.access_token || ''
    if (!input.name.trim() || !access_token.trim()) throw new Error('请填写项目名称和管理员 Access Token')
    const url = new URL(input.base_url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('项目地址无效')
    const same =
      previous &&
      previous.view.base_url === input.base_url &&
      previous.view.user_id === input.user_id &&
      previous.access_token === access_token
    const project: InspectionProject = {
      id: id || `project-${crypto.randomUUID()}`,
      name: input.name,
      kind: input.kind,
      base_url: input.base_url,
      user_id: input.user_id,
      admin_account: input.admin_account,
      has_token: true,
      channels: same ? previous.view.channels : [],
      groups: same ? previous.view.groups : [],
      plan: same
        ? previous.view.plan
        : {
            mode: 'all',
            groups: [],
            channel_ids: [],
            models: [],
            evaluators: ['fingerprint'],
            enabled: false,
            interval_minutes: 60,
          },
      busy: false,
      synced_at: same ? previous.view.synced_at : undefined,
    }
    state.projects[project.id] = { view: project, access_token, keys: same ? previous.keys : {} }
    await writeLocal('inspection', state)
    return project
  }
  return projectMutation<InspectionProject>(client, `/inspection/projects${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(input),
  })
}
export async function deleteInspectionProject(client: APIClient, id: string) {
  if (client.mode === 'local' && !client.token) {
    const state = await localProjectState()
    delete state.projects[id]
    await writeLocal('inspection', state)
    return
  }
  return projectMutation<void>(client, `/inspection/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export const syncInspectionProject = (
  client: APIClient,
  id: string,
  options?: { import_keys: boolean; two_factor_code: string },
) =>
  projectMutation<InspectionProject>(client, `/inspection/projects/${encodeURIComponent(id)}/sync`, {
    method: 'POST',
    body: options ? JSON.stringify(options) : undefined,
  })
export const importInspectionKeys = (client: APIClient, id: string, channel_ids: string[], two_factor_code: string) =>
  projectMutation<InspectionProject>(client, `/inspection/projects/${encodeURIComponent(id)}/keys`, {
    method: 'POST',
    body: JSON.stringify({ channel_ids, two_factor_code }),
  })
export async function saveInspectionPlan(client: APIClient, id: string, input: InspectionPlan) {
  if (client.mode === 'local' && input.enabled)
    throw new Error('浏览器本地不支持离线定时巡检，请关闭定时或保存到云端 / 自建 Worker')
  if (client.mode === 'local' && !client.token) {
    const state = await localProjectState()
    const item = state.projects[id]
    if (!item) throw new Error('项目不存在')
    item.view.plan = input
    item.view.next_run_at = undefined
    await writeLocal('inspection', state)
    return item.view
  }
  return projectMutation<InspectionProject>(client, `/inspection/projects/${encodeURIComponent(id)}/plan`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}
export async function saveInspectionChannelProtocol(
  client: APIClient,
  id: string,
  channelID: string,
  protocol: string,
) {
  if (client.mode === 'local' && !client.token) {
    const state = await localProjectState()
    const item = state.projects[id]
    if (!item) throw new Error('项目不存在')
    const channel = item.view.channels.find((ch) => ch.id === channelID)
    if (!channel) throw new Error('渠道不存在')
    channel.protocol_override = protocol as typeof channel.protocol_override
    await writeLocal('inspection', state)
    return item.view
  }
  return projectMutation<InspectionProject>(
    client,
    `/inspection/projects/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelID)}/protocol`,
    { method: 'PUT', body: JSON.stringify({ protocol }) },
  )
}
export const runInspectionProject = (client: APIClient, id: string) =>
  projectMutation<BatchRun>(client, `/inspection/projects/${encodeURIComponent(id)}/run`, { method: 'POST' })
