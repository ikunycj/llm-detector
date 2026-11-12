import type { SourceID } from '../../data/sources'
import type { Scan } from '../../types'
import type { BatchRun } from '../inspection/types'
import type { BenchJob } from '../terminalbench/types'

export type LogKind = 'scan' | 'batch' | 'bench'
export type LogTarget = { kind: LogKind; id: string; source?: SourceID }
export type LogNavigation = { onOpenLogs: (target?: LogTarget) => void }
type RecordData = { kind: 'scan'; record: Scan } | { kind: 'batch'; record: BatchRun } | { kind: 'bench'; record: BenchJob }
export type LogEntry = RecordData & {
  key: string
  source: SourceID
  service: string
  models: string[]
  engines: string[]
  status: string
  createdAt: string
  targets: string[]
}
export const logKey = (target: LogTarget) => `${target.kind}:${target.source || 'local'}:${target.id}`
export const logKindLabels: Record<LogKind, string> = { scan: '模型巡检', batch: '项目巡检', bench: 'Terminal Bench' }
export const logStatusLabels: Record<string, string> = {
  pending: '等待执行', running: '执行中', completed: '已完成', completed_with_errors: '完成 · 含错误',
  failed: '执行失败', error: '无法执行', cancelling: '正在取消', cancelled: '已取消', interrupted: '已中断',
}
export const logStatusColor = (status: string) => {
  if (status === 'completed') return 'success'
  if (['failed', 'error', 'completed_with_errors'].includes(status)) return 'error'
  if (['pending', 'running', 'cancelling'].includes(status)) return 'processing'
  return 'warning'
}

// Use only explicit IDs to link records. Equal IDs at different locations are separate runs.
export function mergeLogs(scans: Scan[], batches: BatchRun[], jobs: BenchJob[]): LogEntry[] {
  const batchScans = new Set<string>()
  const linkedJobs = new Set<string>()
  const entries: LogEntry[] = []
  function collectJobs(scan: Scan, source: SourceID) {
    const keys: string[] = []
    for (const model of scan.models) {
      if (model.report.kind !== 'terminal-bench' || !model.report.details) continue
      const key = logKey({ kind: 'bench', source, id: (model.report.details as BenchJob).id })
      linkedJobs.add(key)
      keys.push(key)
    }
    return keys
  }
  for (const batch of batches) {
    const source = batch.source || 'local'
    const key = logKey({ kind: 'batch', ...batch })
    const targets = [key]
    for (const item of batch.items) {
      for (const id of [item.scan_id, item.result?.id]) {
        if (!id) continue
        const scanKey = logKey({ kind: 'scan', source, id })
        batchScans.add(scanKey)
        targets.push(scanKey)
      }
      if (item.result) targets.push(...collectJobs(item.result, source))
    }
    entries.push({ kind: 'batch', record: batch, key, source, service: batch.project_name,
      models: [...new Set(batch.items.flatMap((item) => [...item.models, ...(item.result?.models.map((model) => model.model.id) || [])]))],
      engines: [...new Set(batch.items.map((item) => item.evaluator))], status: batch.status, createdAt: batch.created_at, targets })
  }
  for (const scan of scans) {
    const source = scan.source || 'local'
    const key = logKey({ kind: 'scan', ...scan })
    const jobsForScan = collectJobs(scan, source)
    if (batchScans.has(key)) {
      const batch = entries.find((entry) => entry.targets.includes(key))
      batch?.targets.push(...jobsForScan)
      continue
    }
    entries.push({ kind: 'scan', record: scan, key, source, service: scan.service_name || scan.vendor || '未命名服务',
      models: scan.models.map((model) => model.model.id), engines: [scan.evaluator.id], status: scan.status,
      createdAt: scan.created_at, targets: [key, ...jobsForScan] })
  }
  for (const job of jobs) {
    const key = logKey({ kind: 'bench', ...job })
    if (linkedJobs.has(key)) continue
    entries.push({ kind: 'bench', record: job, key, source: job.source || 'local', service: job.service_name,
      models: [job.model], engines: ['terminal-bench'], status: job.status, createdAt: job.created_at, targets: [key] })
  }
  return entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export type LogFilters = { query: string; kind?: LogKind; service?: string; engine?: string; status?: string; source?: SourceID }
export function filterLogs(entries: LogEntry[], filters: LogFilters): LogEntry[] {
  const query = filters.query.trim().toLowerCase()
  return entries.filter((entry) => {
    const names = entry.kind === 'scan' ? entry.record.models.map((model) => model.model.name) : []
    const channels = entry.kind === 'batch' ? entry.record.items.map((item) => item.channel_name) : []
    return (!query || [...entry.models, ...names, ...channels, entry.service, entry.record.id].some((value) => value.toLowerCase().includes(query))) &&
      (!filters.kind || entry.kind === filters.kind) && (!filters.service || entry.service === filters.service) &&
      (!filters.engine || entry.engines.includes(filters.engine)) && (!filters.status || entry.status === filters.status) &&
      (!filters.source || entry.source === filters.source)
  })
}
