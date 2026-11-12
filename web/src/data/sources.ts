export type SourceID = 'local' | 'cloud'
export type APIClient = { mode: SourceID; token: string }
export const sourceID = (client: APIClient): SourceID => client.mode
export const recordKey = (item: { id: string; source?: SourceID }) => `${item.source || 'local'}:${item.id}`
export const sourceName = (source: SourceID | undefined) => source === 'cloud' ? '云端' : '本地'
