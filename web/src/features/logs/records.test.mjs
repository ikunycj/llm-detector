import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterLogs, logKey, mergeLogs } from './records.ts'

const created = '2026-11-12T01:00:00Z'
const model = (id = 'model-a', report = { checks: [] }) => ({ model: { id, name: `Display ${id}` }, status: 'completed', report })
const scan = (overrides = {}) => ({ id: 'scan-1', source: 'local', status: 'completed', vendor: 'openai', service_name: 'API A', evaluator: { id: 'fingerprint', name: '指纹检测' }, scope: 'selected', models: [model()], created_at: created, ...overrides })
const job = (overrides = {}) => ({ id: 'job-1', source: 'local', service_name: 'API B', model: 'bench-model', suite: 'daily', status: 'running', trials: [], created_at: created, ...overrides })
const batch = (overrides = {}) => ({ id: 'batch-1', source: 'local', project_id: 'project-1', project_name: 'New API', trigger: 'manual', status: 'completed', items: [], created_at: created, ...overrides })
const channel = (overrides = {}) => ({ channel_id: 'channel-1', channel_name: '渠道甲', groups: ['default'], models: ['model-a'], evaluator: 'fingerprint', status: 'completed', ...overrides })

test('a fingerprint scan is listed once and equal IDs from different locations stay distinct', () => {
  const entries = mergeLogs(['local', 'cloud', 'worker:a', 'worker:b'].map((source) => scan({ source })), [], [])
  assert.equal(entries.length, 4)
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 4)
  assert.equal(filterLogs(entries, { query: '', source: 'worker:a' }).length, 1)
})

test('batch, child scans and nested Bench jobs are grouped using source and explicit IDs', () => {
  const linked = scan({ evaluator: { id: 'terminal-bench', name: 'Terminal Bench' }, models: [model('bench-model', { kind: 'terminal-bench', checks: [], details: job() })] })
  const run = batch({ items: [channel({ evaluator: 'terminal-bench', scan_id: linked.id, result: linked })] })
  const entries = mergeLogs([linked, scan({ source: 'cloud' })], [run], [job(), job({ source: 'cloud' }), job({ id: 'independent' })])
  assert.equal(entries.length, 4)
  const root = entries.find((entry) => entry.kind === 'batch')
  assert.ok(root.targets.includes(logKey({ kind: 'scan', ...linked })))
  assert.ok(root.targets.includes(logKey({ kind: 'bench', ...job() })))
  assert.ok(entries.some((entry) => entry.kind === 'scan' && entry.source === 'cloud'))
  assert.equal(entries.filter((entry) => entry.kind === 'bench').length, 2)
})

test('batch scan_id links a live scan even before a result snapshot has been saved', () => {
  const live = scan({ models: [model('bench-model', { kind: 'terminal-bench', checks: [], details: job() })] })
  const entries = mergeLogs([live], [batch({ items: [channel({ scan_id: live.id })] })], [job()])
  assert.equal(entries.length, 1)
  assert.ok(entries[0].targets.includes(logKey({ kind: 'bench', ...job() })))
})

test('pending scans and failed batches without model results remain visible', () => {
  const entries = mergeLogs([scan({ models: [], status: 'pending' })], [batch({ status: 'failed', error: '连接失败' })], [])
  assert.equal(entries.length, 2)
  assert.equal(filterLogs(entries, { query: '', status: 'pending' }).length, 1)
  assert.equal(filterLogs(entries, { query: '', status: 'failed' })[0].record.error, '连接失败')
})

test('filters combine model names, project/channel names, engines, type, status and location', () => {
  const entries = mergeLogs([scan()], [batch({ source: 'worker:a', items: [channel({ evaluator: 'future-engine' })] })], [job()])
  assert.equal(filterLogs(entries, { query: 'display MODEL-A' }).length, 1)
  assert.equal(filterLogs(entries, { query: '渠道甲', kind: 'batch', engine: 'future-engine', source: 'worker:a', status: 'completed', service: 'New API' }).length, 1)
  assert.equal(filterLogs(entries, { query: 'model-a', kind: 'batch', engine: 'fingerprint' }).length, 0)
  assert.equal(filterLogs(entries, { query: 'job-1' })[0].kind, 'bench')
})

test('records are sorted by actual creation time, including timezone offsets', () => {
  const entries = mergeLogs([scan({ created_at: '2026-11-12T09:00:00+08:00' })], [batch({ created_at: '2026-11-12T02:00:00Z' })], [job({ created_at: '2026-11-12T00:00:00Z' })])
  assert.deepEqual(entries.map((entry) => entry.kind), ['batch', 'scan', 'bench'])
})
