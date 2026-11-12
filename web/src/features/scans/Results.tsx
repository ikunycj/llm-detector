import { SourceTag } from '../../app/Locations'
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { Alert, Collapse, Empty, Flex, List, Space, Tag, Typography } from 'antd'
import type { FingerprintDetails, ModelResult, Scan } from '../../types'
import type { BenchJob } from '../terminalbench/types'
import FingerprintResult from '../fingerprint/FingerprintResult'
import BenchJobDetails from '../terminalbench/BenchJobDetails'
import { logKey, logStatusColor, logStatusLabels } from '../logs/records'

const { Text, Title } = Typography
const checkLabel = { passed: '通过', failed: '未通过', error: '执行错误' }
const modelLabel = { pending: '等待执行', running: '执行中', completed: '检查完成', error: '存在错误' }

function ChecksResult({ result }: { result: ModelResult }) {
  const checks = Array.isArray(result.report?.checks) ? result.report.checks : []
  return <Collapse items={[{ key: result.model.id, label: `${checks.length} 项检查`, children: <Collapse items={checks.map((check) => ({
    key: check.id,
    label: <Flex justify="space-between" gap={12}><span>{check.status === 'passed' ? <CheckCircleOutlined className="status-icon-passed" /> : check.status === 'error' ? <ExclamationCircleOutlined className="status-icon-error" /> : <CloseCircleOutlined className="status-icon-failed" />} {check.name}</span><Space size={4}><Tag color={check.status === 'passed' ? 'success' : check.status === 'error' ? 'error' : 'warning'}>{checkLabel[check.status]}</Tag><Text type="secondary">{check.latency_ms !== undefined && check.status !== 'error' ? `${check.latency_ms} ms` : '—'}</Text></Space></Flex>,
    children: <div className="check-evidence"><Text type="secondary">{check.error ? '调用错误' : '模型输出摘要'}</Text><pre>{check.error || check.output || '（空输出）'}</pre></div>,
  }))} />}]} />
}

export default function Results({ scans, jobs, onChange }: { scans: Scan[]; jobs: BenchJob[]; onChange: () => void }) {
  return <div className="inspection-log-detail">
    {scans.map((scan) => <section key={logKey({ kind: 'scan', ...scan })}>
      <Space wrap className="inspection-log-detail-toolbar">
        <Text strong>{scan.service_name || scan.vendor}</Text>
        <SourceTag source={scan.source} />
        <Tag>{scan.evaluator.name}</Tag>
        <Tag color={logStatusColor(scan.status)}>{logStatusLabels[scan.status] || scan.status}</Tag>
        <Text type="secondary">{new Date(scan.created_at).toLocaleString('zh-CN')}</Text>
      </Space>
      <Text type="secondary">任务 {scan.id}</Text>
      {scan.error && <Alert type="error" showIcon title={scan.error} />}
      {!scan.models.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={['pending', 'running'].includes(scan.status) ? '正在获取模型与巡检结果…' : '此任务没有模型结果'} />}
      <List className="result-list" dataSource={scan.models} rowKey={(result) => result.model.id} renderItem={(result) => {
        const fingerprint = result.report.kind === 'fingerprint' ? result.report.details as FingerprintDetails | undefined : undefined
        const savedJob = result.report.kind === 'terminal-bench' ? result.report.details as BenchJob | undefined : undefined
        const bench = savedJob && (jobs.find((job) => job.id === savedJob.id && (job.source || 'local') === (scan.source || 'local')) || { ...savedJob, source: scan.source })
        return <List.Item className="result-list-item">
          <div className="result-row-heading">
            <div className="result-row-title"><Title level={4}>{result.model.name}</Title><Text type="secondary">{result.model.id}</Text></div>
            <Tag color={result.status === 'error' ? 'error' : result.status === 'completed' ? 'success' : 'processing'}>{modelLabel[result.status]}</Tag>
          </div>
          {(result.error || result.report.error) && <Alert type="error" showIcon title={result.error || result.report.error} />}
          {fingerprint ? <FingerprintResult details={fingerprint} /> : bench ? <BenchJobDetails key={logKey({ kind: 'bench', ...bench })} job={bench} onChange={onChange} /> : <ChecksResult result={result} />}
        </List.Item>
      }} />
    </section>)}
  </div>
}
