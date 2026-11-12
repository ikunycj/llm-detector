export type SourceID = 'local' | 'cloud' | `worker:${string}`
export type APIClient = {
  mode: 'local' | 'cloud' | 'worker'
  token: string
  id?: string
  baseURL?: string
  name?: string
}
export type WorkerConfig = { id: string; name: string; url: string; key: string }
export const sourceID = (client: APIClient): SourceID =>
  client.mode === 'worker' ? (`worker:${client.id}` as SourceID) : client.mode
export const recordKey = (item: { id: string; source?: SourceID }) => `${item.source || 'local'}:${item.id}`
export const sourceName = (source: SourceID | undefined, clients: APIClient[]) =>
  source?.startsWith('worker:')
    ? `自建 Worker · ${clients.find((client) => sourceID(client) === source)?.name || source.slice(7)}`
    : source === 'cloud'
      ? '云端'
      : '本地'
export const workerClient = (worker: WorkerConfig): APIClient => ({
  mode: 'worker',
  id: worker.id,
  baseURL: worker.url,
  token: worker.key,
  name: worker.name,
})
const workerStorage = 'llm-detector:workers:v1'

export function parseWorker(value: unknown): WorkerConfig {
  if (typeof value !== 'object' || value === null) throw new Error('Worker 配置格式无效')
  const input = value as Record<string, unknown>
  if (
    typeof input.id !== 'string' ||
    !input.id ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    typeof input.url !== 'string' ||
    typeof input.key !== 'string' ||
    !input.key.trim() ||
    /[\r\n]/.test(input.key)
  )
    throw new Error('请填写 Worker 地址和密钥')
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    throw new Error('Worker 地址必须是完整的 HTTP(S) 地址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Worker 地址不能包含账号密码、查询参数或片段')
  return { id: input.id, name: input.name.trim(), url: url.toString().replace(/\/+$/, ''), key: input.key.trim() }
}
export function readWorkers(): WorkerConfig[] {
  const raw = localStorage.getItem(workerStorage)
  if (!raw) return []
  const input: unknown = JSON.parse(raw)
  if (!Array.isArray(input)) throw new Error('浏览器 Worker 配置不是数组')
  return input.map(parseWorker)
}
export function writeWorkers(workers: WorkerConfig[]) {
  localStorage.setItem(workerStorage, JSON.stringify(workers))
}
