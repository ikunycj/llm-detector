import { StopOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Input, Popconfirm, Progress, Space, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { cancelBenchJob } from '../../api'
import { SourceTag, useLocations } from '../../app/Locations'
import { logStatusColor, logStatusLabels } from '../logs/records'
import type { BenchJob } from './types'

const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '—'
const labels: Record<string, string> = { pending: '等待运行', running: '执行中', passed: '通过', failed: '未通过', error: '运行错误', cancelled: '已取消', interrupted: '已中断' }
export default function BenchJobDetails({ job, onChange }: { job: BenchJob; onChange: () => void }) {
  const { owner, changed } = useLocations()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = ['pending', 'running', 'cancelling'].includes(job.status)
  const finished = job.trials.filter((trial) => !['pending', 'running'].includes(trial.status)).length
  async function cancel() {
    setBusy(true); setError('')
    try {
      await cancelBenchJob(owner(job.source), job.id)
      changed(); onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消失败')
    } finally { setBusy(false) }
  }
  return <div className="inspection-log-detail">
    <Space wrap className="inspection-log-detail-toolbar">
      <SourceTag source={job.source} />
      <Tag color={logStatusColor(job.status)}>{logStatusLabels[job.status] || job.status}</Tag>
      <Tag>{job.suite === 'full' ? '完整测试集' : '日常测试集'}</Tag>
      {active && <Popconfirm title="取消当前测试？" description="已消耗的模型额度不会退回，Harbor 会尝试清理容器。" onConfirm={cancel} okText="取消测试" cancelText="继续运行">
        <Button danger icon={<StopOutlined />} loading={busy} disabled={job.status === 'cancelling'}>取消测试</Button>
      </Popconfirm>}
    </Space>
    <Descriptions size="small" column={{ xs: 1, md: 2 }} items={[
      { key: 'id', label: '任务 ID', children: job.id },
      { key: 'service', label: '模型 API', children: job.service_name },
      { key: 'model', label: '模型', children: job.model },
      { key: 'config', label: '执行配置', children: `${job.dataset} / ${job.agent} / Harbor ${job.harbor_version}` },
      { key: 'created', label: '创建时间', children: date(job.created_at) },
      { key: 'finished', label: '结束时间', children: date(job.finished_at) },
    ]} />
    {error && <Alert type="error" title={error} showIcon />}
    {job.error && <Alert type={job.status === 'cancelled' ? 'info' : 'error'} title={job.error} showIcon />}
    <Progress percent={job.trials.length ? Math.round(finished / job.trials.length * 100) : 0} status={active ? 'active' : undefined} format={() => `${finished}/${job.trials.length}`} />
    <Space wrap className="terminal-bench-summary">
      <Tag color="success">通过 {job.trials.filter((trial) => trial.status === 'passed').length}</Tag>
      <Tag color="warning">未通过 {job.trials.filter((trial) => trial.status === 'failed').length}</Tag>
      <Tag color="error">运行错误 {job.trials.filter((trial) => trial.status === 'error').length}</Tag>
      <Typography.Text type="secondary">运行错误不等同于能力题未通过；未完成题目不记作通过。</Typography.Text>
    </Space>
    <Input.Search aria-label="搜索题目" allowClear placeholder="搜索题目名称" value={query} onChange={(event) => setQuery(event.target.value)} style={{ maxWidth: 320, marginBottom: 16 }} />
    <Table rowKey="name" size="small" dataSource={job.trials.filter((trial) => trial.name.toLowerCase().includes(query.trim().toLowerCase()))} pagination={{ pageSize: 10 }} scroll={{ x: 680 }} columns={[
      { title: '题目', dataIndex: 'name' },
      { title: '状态', dataIndex: 'status', render: (status: string) => <Tag color={status === 'passed' ? 'success' : status === 'failed' ? 'warning' : status === 'error' ? 'error' : 'default'}>{labels[status] || status}</Tag> },
      { title: 'Reward', dataIndex: 'reward', render: (value: number | null) => value ?? '—' },
      { title: '完成时间', dataIndex: 'finished_at', render: date },
      { title: '说明', dataIndex: 'error', render: (value?: string) => value || '—' },
    ]} />
  </div>
}
