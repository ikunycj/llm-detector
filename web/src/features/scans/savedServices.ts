import type { Connection } from '../../api'

export type SavedModelService = Connection & {
  id: string
  name: string
  updated_at: string
}

const storageKey = 'llm-detector:model-services:v1'

export function readSavedServices(): SavedModelService[] {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('本地已保存的模型服务格式无效，请清理该配置后再保存。')
  return parsed.map((item) => {
    if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).protocol !== 'string') {
      return { ...(item as Record<string, unknown>), protocol: 'chat_completions' }
    }
    return item
  }).filter((item): item is SavedModelService => {
    if (typeof item !== 'object' || item === null) return false
    const service = item as Record<string, unknown>
    return ['id', 'name', 'vendor', 'protocol', 'base_url', 'api_key', 'updated_at'].every((key) => typeof service[key] === 'string')
  })
}

export function writeSavedServices(services: SavedModelService[]) {
  localStorage.setItem(storageKey, JSON.stringify(services))
}
