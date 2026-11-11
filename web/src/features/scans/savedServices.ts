import type { Connection } from '../../api'

export type ServiceSource = 'local' | 'cloud'

export type ModelAPIConfig = Pick<Connection, 'protocol' | 'base_url' | 'api_key'> & {
  name: string
  scope: 'all' | 'selected'
  models: string[]
}

export type SavedModelService = ModelAPIConfig & Connection & {
  id: string
  source: ServiceSource
  updated_at: string
  has_key?: boolean
}

const storageKey = 'llm-detector:model-services:v1'

// Both local storage and imported JSON are user-controlled input boundaries.
export function parseModelAPI(value: unknown, allowEmptyModels = false, allowSavedKey = false): ModelAPIConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('每项配置必须是 JSON 对象。')
  const input = value as Record<string, unknown>
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('请填写模型 API 名称。')
  if (input.protocol !== 'chat_completions' && input.protocol !== 'responses' && input.protocol !== 'messages') throw new Error('请求协议需为 chat_completions、responses 或 messages。')
  if (typeof input.api_key !== 'string' || (!input.api_key.trim() && !allowSavedKey) || /[\r\n]/.test(input.api_key)) throw new Error('请填写非空且不含换行的 API Key。')
  if (typeof input.base_url !== 'string') throw new Error('请填写 API Base URL。')
  let url: URL
  try { url = new URL(input.base_url.trim()) } catch { throw new Error('API Base URL 需为完整的 HTTP(S) 地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#]/.test(input.base_url)) {
    throw new Error('API Base URL 需为 HTTP(S) 根地址，不能包含用户名、密码、查询参数或片段。')
  }
  if (input.scope !== 'all' && input.scope !== 'selected') throw new Error('巡检模型范围需为 all 或 selected。')
  const suppliedModels = input.models ?? []
  if (!Array.isArray(suppliedModels) || !suppliedModels.every((model) => typeof model === 'string' && model.trim())) throw new Error('models 需为非空模型 ID 组成的数组。')
  const models = [...new Set(suppliedModels.map((model: string) => model.trim()))]
  if (input.scope === 'selected' && !models.length && !allowEmptyModels) throw new Error('指定模型时，至少填写一个模型 ID。')
  return {
    name: input.name.trim(),
    protocol: input.protocol,
    base_url: input.base_url.trim().replace(/\/+$/, ''),
    api_key: input.api_key,
    scope: input.scope,
    models: input.scope === 'all' ? [] : models,
  }
}

export function parseImportedServices(raw: string): ModelAPIConfig[] {
  let input: unknown
  try { input = JSON.parse(raw) } catch { throw new Error('JSON 格式不正确，请检查后重试。') }
  if (!Array.isArray(input) || !input.length) throw new Error('请提供至少包含一项配置的 JSON 数组。')
  return input.map((item, index) => {
    try { return parseModelAPI(item) }
    catch (err) { throw new Error(`第 ${index + 1} 项：${err instanceof Error ? err.message : '配置无效'}`) }
  })
}

export function readSavedServices(): SavedModelService[] {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('浏览器中的模型 API 配置格式无效，原数据已保留。') }
  if (!Array.isArray(parsed)) throw new Error('浏览器中的模型 API 配置必须为数组，原数据已保留。')
  const ids = new Set<string>()
  return parsed.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`本地第 ${index + 1} 项配置无效，原数据已保留。`)
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.vendor !== 'string' || typeof item.updated_at !== 'string') throw new Error(`本地第 ${index + 1} 项标识无效，原数据已保留。`)
    ids.add(item.id)
    const config = parseModelAPI({ ...item, protocol: item.protocol ?? 'chat_completions', scope: item.scope ?? 'selected', models: item.models ?? [] }, true)
    return { ...config, id: item.id, source: 'local', vendor: item.vendor, service_name: config.name, updated_at: item.updated_at }
  })
}

export function writeSavedServices(services: SavedModelService[]) {
  localStorage.setItem(storageKey, JSON.stringify(services.map(({ source: _source, has_key: _hasKey, ...service }) => service)))
}
