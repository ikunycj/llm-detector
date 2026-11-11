import type { Scan } from '../types'
import type { BatchRun, InspectionProject } from '../features/inspection/types'
import type { BenchJob } from '../features/terminalbench/types'

export type LocalProjectState = { version: number; projects: Record<string, { view: InspectionProject; access_token: string; keys: Record<string, string> }>; runs: BatchRun[] }
let database: Promise<IDBDatabase> | undefined
function open() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('llm-detector-local', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('data') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(new Error('无法打开浏览器本地数据库')) }
  })
  return database
}
export async function readLocal<T>(key: string): Promise<T | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction('data', 'readonly').objectStore('data').get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('读取浏览器本地数据失败'))
  })
}
export async function writeLocal(key: string, value: unknown) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('data', 'readwrite')
    transaction.objectStore('data').put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(new Error('浏览器本地保存失败，请检查存储空间或隐私设置'))
  })
}
export async function mergeLocal<T extends { id: string; created_at: string }>(key: string, items: T[]): Promise<T[]> {
  // One read/write transaction prevents overlapping polling responses from losing rows.
  const db = await open()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('data', 'readwrite'); const store = transaction.objectStore('data')
    const request = store.get(key)
    let merged: T[] = []
    request.onsuccess = () => {
      const known = new Map<string, T>((request.result || []).map((item: T) => [item.id, item]))
      items.forEach((item) => known.set(item.id, item))
      merged = [...known.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
      store.put(merged, key)
    }
    transaction.oncomplete = () => resolve(merged)
    transaction.onerror = transaction.onabort = () => reject(new Error('浏览器本地历史保存失败'))
  })
}
export const localScans = () => readLocal<Scan[]>('scans')
export const localBenchJobs = () => readLocal<BenchJob[]>('bench-jobs')

export async function cleanupLegacyScans() {
  const scans = await readLocal<Scan[]>('scans') || []
  const cleaned = scans.filter((scan) => Array.isArray(scan.models) && scan.models.every((model) => Array.isArray(model.report?.checks)))
  if (cleaned.length !== scans.length) await writeLocal('scans', cleaned)
  return cleaned
}
