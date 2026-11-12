import { ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Drawer, Empty, Input, Layout, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getBenchJobs, getCatalog, getInspectionRuns, listScans, type APIClient } from '../../api'
import { SourceTag, useLocations, useSourceData } from '../../app/Locations'
import type { Evaluator } from '../../types'
import Results from '../scans/Results'
import BenchJobDetails from '../terminalbench/BenchJobDetails'
import BatchRunDetails from './BatchRunDetails'
import { filterLogs, logKey, logKindLabels, logStatusColor, logStatusLabels, mergeLogs, type LogEntry, type LogFilters, type LogTarget } from './records'

const loadScans = (client: APIClient, signal: AbortSignal) => listScans(client, signal).then((data) => data.scans)
const loadBatches = (client: APIClient, signal: AbortSignal) => getInspectionRuns(client, signal).then((data) => data.runs)
const loadJobs = (client: APIClient, signal: AbortSignal) => getBenchJobs(client, signal).then((data) => data.jobs)
const { Text, Title } = Typography
export default function LogsPage({ initialTarget }: { initialTarget?: LogTarget }) {
  const scans = useSourceData(loadScans, 3000)
  const batches = useSourceData(loadBatches, 3000)
  const jobs = useSourceData(loadJobs, 3000)
  const { label } = useLocations()
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [filters, setFilters] = useState<LogFilters>({ query: '' })
  const [selected, setSelected] = useState<string>()
  const [catalogRevision, setCatalogRevision] = useState(0)
  useEffect(() => setSelected(initialTarget && logKey(initialTarget)), [initialTarget])
  useEffect(() => {
    const controller = new AbortController()
    getCatalog(controller.signal).then((data) => { setEngines(data.evaluators); setCatalogError('') }).catch((err) => {
      if (!controller.signal.aborted) setCatalogError(err instanceof Error ? err.message : '引擎目录加载失败')
    })
    return () => controller.abort()
  }, [catalogRevision])
  const entries = useMemo(() => mergeLogs(scans.items, batches.items, jobs.items), [scans.items, batches.items, jobs.items])
  const filtered = useMemo(() => filterLogs(entries, filters), [entries, filters])
  const current = entries.find((entry) => entry.targets.includes(selected || ''))
  const engineNames = new Map(scans.items.map((scan) => [scan.evaluator.id, scan.evaluator.name]))
  for (const batch of batches.items) for (const item of batch.items) if (item.result) engineNames.set(item.evaluator, item.result.evaluator.name)
  for (const engine of engines) engineNames.set(engine.id, engine.name)
  const loading = scans.loading || batches.loading || jobs.loading
  const errors = [
    ...scans.errors.map((error) => `模型巡检：${error}`),
    ...batches.errors.map((error) => `项目巡检：${error}`),
    ...jobs.errors.map((error) => `Terminal Bench：${error}`),
    ...(catalogError ? [catalogError] : []),
  ]
  function refresh() { scans.refresh(); batches.refresh(); jobs.refresh(); setCatalogRevision((value) => value + 1) }
  const sources = [...new Set(entries.map((entry) => entry.source))]
  return <Layout>
    <Layout.Content className="app-content inspection-logs-content">
      <div className="page-heading inspection-logs-heading">
        <div><Title level={1}>巡检日志</Title><Text type="secondary">统一查看模型巡检、项目批次与引擎运行记录。</Text></div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>刷新</Button>
      </div>
      {errors.map((error) => <Alert key={error} type="warning" showIcon title={error} action={<Button size="small" onClick={refresh}>重试</Button>} />)}
      <div className="inspection-log-filters">
        <Input.Search aria-label="搜索巡检日志" allowClear placeholder="模型、服务、项目、渠道或任务 ID" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
        <Select aria-label="日志类型" allowClear placeholder="全部类型" value={filters.kind} onChange={(kind) => setFilters({ ...filters, kind })} options={Object.entries(logKindLabels).map(([value, label]) => ({ value, label }))} />
        <Select aria-label="模型服务或项目" allowClear showSearch optionFilterProp="label" placeholder="模型服务 / 项目" value={filters.service} onChange={(service) => setFilters({ ...filters, service })} options={[...new Set(entries.map((entry) => entry.service))].sort().map((value) => ({ value, label: value }))} />
        <Select aria-label="日志巡检引擎" allowClear placeholder="全部引擎" value={filters.engine} onChange={(engine) => setFilters({ ...filters, engine })} options={[...new Set(entries.flatMap((entry) => entry.engines))].map((value) => ({ value, label: engineNames.get(value) || value }))} />
        <Select aria-label="日志状态" allowClear placeholder="全部状态" value={filters.status} onChange={(status) => setFilters({ ...filters, status })} options={Object.entries(logStatusLabels).map(([value, label]) => ({ value, label }))} />
        <Select aria-label="日志保存位置" allowClear placeholder="全部位置" value={filters.source} onChange={(source) => setFilters({ ...filters, source })} options={sources.map((value) => ({ value, label: label(value) }))} />
        <Button onClick={() => setFilters({ query: '' })}>清除筛选</Button>
      </div>
      <div className="inspection-log-count"><Text type="secondary">{filtered.length} / {entries.length} 条记录</Text><Text type="secondary">按创建时间倒序 · 每 3 秒刷新</Text></div>
      <Table<LogEntry> rowKey="key" loading={loading} dataSource={filtered} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 1120 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={entries.length ? '没有符合筛选条件的日志' : errors.length ? '部分来源加载失败，可重试或检查连接。' : '还没有巡检日志，执行模型或项目巡检后会显示在这里。'} /> }} columns={[
        { title: '创建时间', width: 175, render: (_, entry) => new Date(entry.createdAt).toLocaleString('zh-CN') },
        { title: '类型', width: 110, render: (_, entry) => logKindLabels[entry.kind] },
        { title: '模型服务 / 项目', width: 210, render: (_, entry) => <Space orientation="vertical" size={0}><Text strong>{entry.service}</Text><Text type="secondary" ellipsis={{ tooltip: entry.record.id }} style={{ maxWidth: 190 }}>{entry.record.id}</Text></Space> },
        { title: '模型', width: 190, render: (_, entry) => <Text ellipsis={{ tooltip: entry.models.join('、') }} style={{ maxWidth: 180 }}>{entry.models.join('、') || '—'}</Text> },
        { title: '巡检引擎', width: 170, render: (_, entry) => entry.engines.map((id) => engineNames.get(id) || id).join('、') || '—' },
        { title: '位置', width: 130, render: (_, entry) => <SourceTag source={entry.source} /> },
        { title: '状态', width: 155, render: (_, entry) => <Tag color={logStatusColor(entry.status)}>{logStatusLabels[entry.status] || entry.status}</Tag> },
        { title: '操作', width: 100, fixed: 'right', render: (_, entry) => <Button type="link" onClick={() => setSelected(entry.key)}>查看详情</Button> },
      ]} />
    </Layout.Content>
    <Drawer title={current ? `${logKindLabels[current.kind]}详情` : '巡检日志详情'} open={Boolean(selected)} onClose={() => setSelected(undefined)} size={1180} extra={<Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>}>
      {current?.kind === 'scan' && <Results scans={[current.record]} jobs={jobs.items} onChange={refresh} />}
      {current?.kind === 'batch' && <BatchRunDetails run={current.record} scans={scans.items} jobs={jobs.items} engines={engines} onChange={refresh} />}
      {current?.kind === 'bench' && <BenchJobDetails key={current.key} job={current.record} onChange={refresh} />}
      {selected && !current && <Empty description={loading ? '正在加载日志…' : '当前连接中未找到这条日志，请检查来源连接后刷新。'} />}
    </Drawer>
  </Layout>
}
