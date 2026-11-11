import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, FieldTimeOutlined, FilterOutlined } from '@ant-design/icons'
import { Alert, Badge, Button, Card, Collapse, Empty, Flex, Input, List, Progress, Select, Space, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import type { Evaluator, FingerprintDetails, ModelResult, Scan } from '../../types'
import type { BenchJob } from '../terminalbench/types'

const { Text, Title } = Typography

export const statusLabel = (status: Scan['status']) => ({ pending: '等待执行', running: '执行中', completed: '已完成', completed_with_errors: '完成 · 含调用错误', failed: '任务失败' })[status]
const checkLabel = { passed: '通过', failed: '未通过', error: '执行错误' }
const modelLabel = { pending: '等待执行', running: '执行中', completed: '检查完成', error: '存在错误' }
type ResultRow = { key: string; scan: Scan; result: ModelResult }

function FingerprintResult({ details }: { details: FingerprintDetails }) {
  return <Space orientation="vertical" size={8} className="result-detail-block">
    {details.prediction_name && <Text strong>最相似候选：{details.prediction_name}</Text>}
    <Space wrap>
      {details.probability != null && <Tag color="blue">参考库内概率 {(details.probability * 100).toFixed(1)}%</Tag>}
      <Tag>参考数据 {details.reference_built_at || '未知版本'}</Tag>
    </Space>
    {details.error && <Alert type="warning" showIcon message={details.error} />}
    <Collapse items={[
      { key: 'candidates', label: `候选排名（${(details.candidates || []).length}）`, children: <List size="small" dataSource={(details.candidates || []).slice(0, 10)} renderItem={(candidate, index) => <List.Item><Space><Text type="secondary">{index + 1}.</Text><Text strong>{candidate.display_name || candidate.model}</Text><Text type="secondary">{candidate.family_name || candidate.family}</Text></Space></List.Item>} /> },
      { key: 'samples', label: `挑战样本（${(details.samples || []).length}）`, children: <List size="small" dataSource={details.samples || []} renderItem={(sample, index) => <List.Item>样本 {index + 1}：{sample.count}/{sample.expected_count} 个整数，{sample.state}{sample.error ? ` · ${sample.error}` : ''}</List.Item>} /> },
    ]} />
    <Text type="secondary">封闭参考库候选排序，不是身份认证或智力评分。概率只在参考库内比较。</Text>
  </Space>
}

function ChecksResult({ result }: { result: ModelResult }) {
  const checks = Array.isArray(result.report?.checks) ? result.report.checks : []
  return <Collapse items={[{ key: result.model.id, label: `${checks.length} 项检查`, children: <Collapse items={checks.map((check) => ({
    key: check.id,
    label: <Flex justify="space-between" gap={12}><span>{check.status === 'passed' ? <CheckCircleOutlined className="status-icon-passed" /> : check.status === 'error' ? <ExclamationCircleOutlined className="status-icon-error" /> : <CloseCircleOutlined className="status-icon-failed" />} {check.name}</span><Space size={4}><Tag color={check.status === 'passed' ? 'success' : check.status === 'error' ? 'error' : 'warning'}>{checkLabel[check.status]}</Tag><Text type="secondary">{check.latency_ms !== undefined && check.status !== 'error' ? `${check.latency_ms} ms` : '—'}</Text></Space></Flex>,
    children: <div className="check-evidence"><Text type="secondary">{check.error ? '调用错误' : '模型输出摘要'}</Text><pre>{check.error || check.output || '（空输出）'}</pre></div>,
  }))} />}]} />
}

export default function Results({ scans, engines }: { scans: Scan[]; engines: Evaluator[] }) {
  const [modelQuery, setModelQuery] = useState('')
  const [serviceFilter, setServiceFilter] = useState<string | undefined>()
  const [engineFilter, setEngineFilter] = useState<string | undefined>()
  const [statusFilter, setStatusFilter] = useState<string | undefined>()

  const rows = useMemo<ResultRow[]>(() => scans.flatMap((scan) => scan.models.map((result) => ({ key: `${scan.source || 'local'}:${scan.id}:${result.model.id}`, scan, result }))), [scans])
  const serviceOptions = useMemo(() => [...new Set(scans.map((scan) => scan.service_name || scan.vendor || '未命名服务'))].sort().map((value) => ({ label: value, value })), [scans])
  const engineOptions = useMemo(() => {
    const known = new Map(engines.map((engine) => [engine.id, engine.name]))
    return [...new Set(scans.map((scan) => scan.evaluator.id))].sort().map((value) => ({ label: known.get(value) || value, value }))
  }, [engines, scans])
  const statusOptions = [
    { label: '等待/执行中', value: 'active' },
    { label: '已完成', value: 'completed' },
    { label: '含调用错误', value: 'completed_with_errors' },
    { label: '任务失败', value: 'failed' },
  ]
  const filteredRows = useMemo(() => rows.filter(({ scan, result }) => {
    const query = modelQuery.trim().toLowerCase()
    const modelMatches = !query || result.model.name.toLowerCase().includes(query) || result.model.id.toLowerCase().includes(query)
    const serviceMatches = !serviceFilter || (scan.service_name || scan.vendor || '未命名服务') === serviceFilter
    const engineMatches = !engineFilter || scan.evaluator.id === engineFilter
    const normalizedStatus = scan.status === 'pending' || scan.status === 'running' ? 'active' : scan.status
    const statusMatches = !statusFilter || normalizedStatus === statusFilter
    return modelMatches && serviceMatches && engineMatches && statusMatches
  }), [engineFilter, modelQuery, rows, serviceFilter, statusFilter])
  const activeCount = rows.filter(({ scan }) => scan.status === 'pending' || scan.status === 'running').length

  function clearFilters() {
    setModelQuery('')
    setServiceFilter(undefined)
    setEngineFilter(undefined)
    setStatusFilter(undefined)
  }

  if (!scans.length) return <Card className="results-card" title="巡检结果"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有巡检任务。配置模型服务和检测引擎后开始。" /></Card>

  return <Card className="results-card" title={<Space><FieldTimeOutlined />巡检结果</Space>} extra={<Space><Badge status={activeCount ? 'processing' : 'default'} text={`${filteredRows.length}/${rows.length} 条结果`} />{activeCount > 0 && <Tag color="processing">{activeCount} 条执行中</Tag>}</Space>}>
    <Card size="small" className="result-filter-card" title={<Space><FilterOutlined />筛选结果</Space>}>
      <Flex wrap gap={12} align="center">
        <Input allowClear value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="模型名或模型 ID" style={{ width: 230 }} />
        <Select allowClear value={serviceFilter} onChange={setServiceFilter} placeholder="模型服务" options={serviceOptions} style={{ minWidth: 190 }} />
        <Select allowClear value={engineFilter} onChange={setEngineFilter} placeholder="巡检引擎" options={engineOptions} style={{ minWidth: 180 }} />
        <Select allowClear value={statusFilter} onChange={setStatusFilter} placeholder="任务状态" options={statusOptions} style={{ minWidth: 150 }} />
        <Button onClick={clearFilters}>清除筛选</Button>
      </Flex>
    </Card>
    {!filteredRows.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合筛选条件的结果" /> : <List className="result-list" dataSource={filteredRows} renderItem={({ scan, result }) => {
      const checks = Array.isArray(result.report?.checks) ? result.report.checks : []
      const passed = checks.filter((check) => check.status === 'passed').length
      const percent = checks.length ? Math.round((passed / checks.length) * 100) : 0
      const fingerprint = result.report.kind === 'fingerprint' ? result.report.details as FingerprintDetails | undefined : undefined
      const bench = result.report.kind === 'terminal-bench' ? result.report.details as BenchJob | undefined : undefined
      const service = scan.service_name || scan.vendor || '未命名服务'
      return <List.Item className="result-list-item">
        <div className="result-row-heading">
          <div className="result-row-title"><Title level={4}>{result.model.name}</Title><Text type="secondary">{result.model.id}</Text></div>
          <Space wrap><Tag color="blue">{service}</Tag><Tag color={scan.source === 'cloud' ? 'blue' : 'default'}>{scan.source === 'cloud' ? '云端结果' : '本地结果'}</Tag><Tag>{scan.evaluator.name}</Tag><Tag color={scan.status === 'completed' ? 'success' : scan.status === 'completed_with_errors' || scan.status === 'failed' ? 'error' : 'processing'}>{statusLabel(scan.status)}</Tag>{fingerprint ? <Tag color={result.status === 'error' ? 'error' : 'processing'}>{fingerprint.decision || '指纹结果'}</Tag> : <Progress type="circle" size={42} percent={percent} status={result.status === 'error' ? 'exception' : undefined} />}</Space>
        </div>
        <Flex wrap gap={12} className="result-row-meta"><Text type="secondary">任务 {scan.id}</Text><Text type="secondary">{new Date(scan.created_at).toLocaleString('zh-CN')}</Text><Text type="secondary">{result.status === 'error' ? '模型结果存在调用错误' : modelLabel[result.status]}</Text></Flex>
        {result.error && <Alert message={result.error} type="error" showIcon />}
        {bench && <Space wrap className="fingerprint-summary"><Tag>{bench.suite === 'full' ? '完整测试集' : '日常测试集'}</Tag><Text type="secondary">{bench.dataset} · {bench.agent} · 任务 {bench.id}</Text></Space>}
        {fingerprint ? <FingerprintResult details={fingerprint} /> : <ChecksResult result={result} />}
      </List.Item>
    }} />}
  </Card>
}
