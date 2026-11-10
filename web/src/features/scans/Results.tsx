import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, FieldTimeOutlined } from '@ant-design/icons'
import { Alert, Badge, Card, Collapse, Empty, Flex, List, Progress, Space, Tag, Typography } from 'antd'
import type { Scan } from '../../types'

const { Text, Title } = Typography

export const statusLabel = (status: Scan['status']) => ({ pending: '等待执行', running: '执行中', completed: '已完成', completed_with_errors: '完成 · 含调用错误', failed: '任务失败' })[status]
const checkLabel = { passed: '通过', failed: '未通过', error: '调用错误' }
const modelLabel = { pending: '等待执行', running: '执行中', completed: '检查完成', error: '存在错误' }

export default function Results({ scan }: { scan: Scan | null }) {
  if (!scan) return <Card className="results-card" title="巡检结果"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="配置模型服务和检测范围后开始，结果会在这里逐个显示。" /></Card>
  const checks = scan.models.flatMap((model) => model.report.checks)
  const passed = checks.filter((check) => check.status === 'passed').length
  const failed = checks.filter((check) => check.status === 'failed').length
  const errors = checks.filter((check) => check.status === 'error').length
  const active = scan.status === 'running' || scan.status === 'pending'
  return <Card className="results-card" title={<Space><FieldTimeOutlined />巡检结果</Space>} extra={<Tag color={scan.status === 'completed' ? 'success' : scan.status === 'completed_with_errors' || scan.status === 'failed' ? 'error' : 'processing'}>{statusLabel(scan.status)}</Tag>}>
    <Flex wrap gap={12} className="result-meta"><Text code>{scan.id}</Text><Text type="secondary">{scan.evaluator.name} · v{scan.evaluator.version}</Text><Text type="secondary">{new Date(scan.created_at).toLocaleString('zh-CN')}</Text></Flex>
    {scan.error && <Alert message={scan.error} type="error" showIcon />}
    {active && <Alert message={`正在逐个巡检模型，完成 ${scan.models.filter((model) => ['completed', 'error'].includes(model.status)).length} / ${scan.models.length || '待发现'}。结果自动更新。`} type="info" showIcon />}
    {checks.length > 0 && <Flex wrap gap={16} className="result-summary"><Badge status="success" text={`${passed} 项通过`} /><Badge status="warning" text={`${failed} 项未通过`} /><Badge status="error" text={`${errors} 项调用错误`} /><Text type="secondary">调用错误单独统计；基础检查不代表通用智力评分。</Text></Flex>}
    <List className="model-results" dataSource={scan.models} renderItem={(result) => {
      const modelChecks = result.report.checks
      const modelPassed = modelChecks.filter((check) => check.status === 'passed').length
      const modelPercent = modelChecks.length ? Math.round((modelPassed / modelChecks.length) * 100) : 0
      return <List.Item className="model-result">
        <div className="model-result-header">
          <div><Title level={4}>{result.model.name}</Title><Text type="secondary">{modelLabel[result.status]}</Text></div>
          <Progress type="circle" size={48} percent={modelPercent} status={result.status === 'error' ? 'exception' : undefined} />
        </div>
        {result.error && <Alert message={result.error} type="error" showIcon />}
        <Collapse items={[{ key: result.model.id, label: `${modelChecks.length} 项检查`, children: <Collapse items={modelChecks.map((check) => ({ key: check.id, label: <Flex justify="space-between" gap={12}><span>{check.status === 'passed' ? <CheckCircleOutlined className="status-icon-passed" /> : check.status === 'error' ? <ExclamationCircleOutlined className="status-icon-error" /> : <CloseCircleOutlined className="status-icon-failed" />} {check.name}</span><Space size={4}><Tag color={check.status === 'passed' ? 'success' : check.status === 'error' ? 'error' : 'warning'}>{checkLabel[check.status]}</Tag><Text type="secondary">{check.latency_ms !== undefined && check.status !== 'error' ? `${check.latency_ms} ms` : '—'}</Text></Space></Flex>, children: <div className="check-evidence"><Text type="secondary">{check.error ? '调用错误' : '模型输出摘要'}</Text><pre>{check.error || check.output || '（空输出）'}</pre></div> }))} />}]} />
      </List.Item>
    }} />
  </Card>
}
