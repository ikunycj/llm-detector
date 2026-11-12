import { Alert, Descriptions, Table, Tag } from 'antd'
import { SourceTag } from '../../app/Locations'
import type { Evaluator, Scan } from '../../types'
import type { BatchRun } from '../inspection/types'
import Results from '../scans/Results'
import type { BenchJob } from '../terminalbench/types'
import { logStatusColor, logStatusLabels } from './records'

export default function BatchRunDetails({ run, scans, jobs, engines, onChange }: {
  run: BatchRun; scans: Scan[]; jobs: BenchJob[]; engines: Evaluator[]; onChange: () => void
}) {
  const source = run.source || 'local'
  const items = run.items.map((item) => ({ ...item,
    result: item.result || scans.find((scan) => scan.id === item.scan_id && (scan.source || 'local') === source),
  }))
  return <div className="inspection-log-detail">
    <SourceTag source={source} />
    <Descriptions column={{ xs: 1, md: 2 }} items={[
      { key: 'project', label: '项目', children: run.project_name },
      { key: 'id', label: '批次', children: run.id },
      { key: 'time', label: '创建时间', children: new Date(run.created_at).toLocaleString('zh-CN') },
      { key: 'trigger', label: '触发方式', children: run.trigger === 'manual' ? '手动巡检' : run.trigger === 'schedule' ? '定时巡检' : run.trigger },
      { key: 'status', label: '状态', children: <Tag color={logStatusColor(run.status)}>{logStatusLabels[run.status] || run.status}</Tag> },
    ]} />
    {run.error && <Alert type="error" showIcon title={run.error} />}
    <Table<BatchRun['items'][number]> size="small" rowKey={(item) => `${item.channel_id}:${item.evaluator}`} dataSource={items} pagination={{ pageSize: 10 }} scroll={{ x: 750 }} expandable={{
      rowExpandable: (item) => Boolean(item.result),
      expandedRowRender: (item) => item.result && <Results scans={[{ ...item.result, source }]} jobs={jobs} onChange={onChange} />,
      columnTitle: '结果',
    }} columns={[
      { title: '渠道', dataIndex: 'channel_name' },
      { title: '模型', render: (_, item) => item.models.join('、') || '全部模型' },
      { title: '巡检引擎', dataIndex: 'evaluator', render: (id: string) => engines.find((engine) => engine.id === id)?.name || items.find((item) => item.evaluator === id && item.result)?.result?.evaluator.name || id },
      { title: '状态', dataIndex: 'status', render: (status: string) => <Tag color={logStatusColor(status)}>{logStatusLabels[status] || status}</Tag> },
      { title: '说明', render: (_, item) => item.error || item.result?.error || '—' },
    ]} />
  </div>
}
