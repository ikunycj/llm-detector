import { RadarChartOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { Alert, Badge, Button, Card, Col, Form, Input, InputNumber, Layout, List, Progress, Row, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, createScan, getEvaluators, getScan, listScans, type Connection } from '../../api'
import type { Evaluator, FingerprintDetails, Scan } from '../../types'

const { Content, Footer } = Layout
const { Text, Title } = Typography
type FormValues = Connection & { model: string; api: string; count: number; strict: boolean; timeout_seconds: number }

const decisionLabels: Record<string, { label: string; color: string }> = {
  scored: { label: '完整排名', color: 'success' },
  partial: { label: '部分样本排名', color: 'warning' },
  unscorable: { label: '样本不足', color: 'default' },
  not_model: { label: '回答不像语言模型', color: 'error' },
}

type CandidateRow = FingerprintDetails['candidates'][number] & { key: string; rank: number }
const columns: ColumnsType<CandidateRow> = [
  { title: '排名', dataIndex: 'rank', width: 72 },
  { title: '候选模型', dataIndex: 'display_name', render: (value: string, row) => <Space orientation="vertical" size={0}><Text strong>{value || row.model}</Text><Text type="secondary">{row.model}</Text></Space> },
  { title: '系列', dataIndex: 'family_name', render: (value: string, row) => value || row.family || '—' },
  { title: '排名分数', dataIndex: 'score', align: 'right', render: (value: number) => value.toFixed(6) },
  { title: '参考库概率', dataIndex: 'probability', align: 'right', render: (value: number | null) => value == null ? '不可用' : `${(value * 100).toFixed(1)}%` },
]

export default function FingerprintPage({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [form] = Form.useForm<FormValues>()
  const [engine, setEngine] = useState<Evaluator | null>(null)
  const [scan, setScan] = useState<Scan | null>(null)
  const [history, setHistory] = useState<Scan[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [revision, setRevision] = useState(0)
  const active = scan?.status === 'pending' || scan?.status === 'running'
  const scanID = scan?.id

  const handleError = useCallback((value: unknown) => {
    if (value instanceof ApiError && value.status === 401) { onExpired(); return }
    setError(value instanceof Error ? value.message : '请求失败')
  }, [onExpired])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([getEvaluators(token, controller.signal), listScans(token, controller.signal)]).then(([registry, response]) => {
      if (controller.signal.aborted) return
      const found = registry.evaluators.find((item) => item.id === 'fingerprint') || null
      setEngine(found)
      const items = response.scans.filter((item) => item.evaluator.id === 'fingerprint')
      setHistory(items)
      setScan(items[0] || null)
      if (!found) setError('服务端未注册 Fingerpoint 引擎，请重启后端。')
    }).catch((value: unknown) => { if (!controller.signal.aborted) handleError(value) })
    return () => controller.abort()
  }, [token, handleError])

  useEffect(() => {
    if (!active || !scanID) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setPollError('')
    async function poll() {
      try {
        const item = await getScan(token, scanID!, controller.signal)
        if (controller.signal.aborted) return
        setScan(item)
        setHistory((current) => [item, ...current.filter((previous) => previous.id !== item.id)])
        if (item.status === 'pending' || item.status === 'running') timer = setTimeout(poll, 1200)
      } catch (value) {
        if (controller.signal.aborted) return
        if (value instanceof ApiError && value.status === 401) onExpired()
        else setPollError(value instanceof Error ? value.message : '无法读取任务进度')
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, scanID, token, onExpired, revision])

  async function submit(values: FormValues) {
    if (values.strict && values.count !== 3) {
      setError('严格模式要求 3 条样本，请将样本数设为 3 或关闭严格模式。')
      return
    }
    setBusy('start'); setError(''); setPollError('')
    try {
      const item = await createScan(token, {
        vendor: '',
        service_name: values.service_name.trim(),
        protocol: values.api === 'messages' ? 'messages' : 'chat_completions',
        base_url: values.base_url,
        api_key: values.api_key,
        scope: 'selected',
        models: [values.model],
        evaluator: 'fingerprint',
        evaluator_options: { api: values.api, count: values.count, strict: values.strict, timeout_seconds: values.timeout_seconds },
      })
      setScan(item)
      setHistory((current) => [item, ...current.filter((previous) => previous.id !== item.id)])
    } catch (value) { handleError(value) }
    finally { setBusy('') }
  }

  const report = scan?.models[0]?.report
  const details = report?.kind === 'fingerprint' ? report.details : undefined
  const result = details as FingerprintDetails | undefined
  const scanError = scan?.models[0]?.error
  const decision = result?.decision ? decisionLabels[result.decision] || { label: result.decision, color: 'default' } : undefined
  const candidates: CandidateRow[] = (result?.candidates || []).map((candidate, index) => ({ ...candidate, key: candidate.model, rank: index + 1 }))

  return <Layout className="engine-embedded-layout">
    <Content className="app-content fingerprint-content">
      <div className="page-heading">
        <Title level={1}><Space><RadarChartOutlined />指纹检测</Space></Title>
        <Text type="secondary">通过随机整数输出的统计特征，寻找参考库中最相似的模型候选。</Text>
      </div>
      <Alert className="fingerprint-disclaimer" type="warning" showIcon message="指纹排名不是模型身份认证" description="结果仅在当前参考库候选范围内比较。库外模型也会匹配到最相似候选；概率不是身份置信保证。高风险判断应固定参数并重复多轮。每轮会让模型生成最多 3 组约 300 个整数，可能产生费用。" />
      {error && <Alert message={error} type="error" showIcon closable onClose={() => setError('')} />}
      <Row gutter={[20, 20]} align="stretch" className="workspace-grid">
        <Col xs={24} lg={10}>
          <Card title="检测配置" className="workspace-card">
            <Form form={form} layout="vertical" requiredMark={false} initialValues={{ service_name: '', api: 'chat_completions', count: 3, strict: true, timeout_seconds: 120 }} onFinish={submit} disabled={Boolean(busy) || Boolean(active)}>
              <Form.Item name="service_name" label="服务名称" extra="用于结果列表筛选；可以留空，系统会使用 Base URL。">
                <Input placeholder="例如：生产网关" />
              </Form.Item>
              <Form.Item name="base_url" label="API Base URL" rules={[{ required: true, message: '请输入 API 根地址' }, { type: 'url', message: '请输入有效的 HTTP(S) URL' }]}>
                <Input placeholder="https://api.example.com/v1" autoComplete="off" />
              </Form.Item>
              <Form.Item name="api_key" label="模型 API Key" rules={[{ required: true, message: '请输入模型 API Key' }]}>
                <Input.Password autoComplete="off" />
              </Form.Item>
              <Form.Item name="model" label="目标模型 ID" rules={[{ required: true, whitespace: true, message: '请输入模型 ID' }]}>
                <Input placeholder="例如：gpt-4.1-mini" />
              </Form.Item>
              <Form.Item name="api" label="请求协议">
                <Select options={[{ value: 'chat_completions', label: 'OpenAI Chat Completions' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'messages', label: 'Anthropic Messages' }]} />
              </Form.Item>
              <Row gutter={16}>
                <Col span={12}><Form.Item name="count" label="挑战样本数"><InputNumber min={1} max={3} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={12}><Form.Item name="timeout_seconds" label="单次请求超时（秒）"><InputNumber min={1} max={3600} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
              </Row>
              <Form.Item name="strict" label="严格模式" valuePropName="checked" extra="要求所有样本都完整有效，否则不生成排名；需要 3 条样本。">
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
              {engine && <Text type="secondary">首次检测需要下载并缓存官方参考数据。</Text>}
              <Button type="primary" htmlType="submit" block icon={<PlayCircleOutlined />} loading={busy === 'start'} disabled={!engine || Boolean(active)}>
                {active ? '指纹检测进行中…' : '开始指纹检测'}
              </Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          {history.length > 0 && <Card size="small" className="history-card" title="本次服务运行中的指纹任务">
            <Select style={{ width: '100%' }} value={scan?.id || undefined} disabled={Boolean(active)} onChange={(value) => setScan(history.find((item) => item.id === value) || null)} options={history.map((item) => ({ value: item.id, label: `${new Date(item.created_at).toLocaleString('zh-CN')} · ${item.models[0]?.model.id || item.id} · ${item.status}` }))} />
          </Card>}
          {pollError && <Alert message={`进度读取已暂停：${pollError}`} type="error" showIcon action={<Button type="link" onClick={() => setRevision((value) => value + 1)}>重试</Button>} />}
          {!scan && <Card title="检测结果"><Text type="secondary">提交检测配置后，挑战样本和候选排名会显示在这里。</Text></Card>}
          {active && <Card title="检测进度"><Space orientation="vertical"><Progress percent={scan.models.length ? Math.round((scan.models.filter((item) => ['completed', 'error'].includes(item.status)).length / scan.models.length) * 100) : 10} status="active" /><Text type="secondary">SDK 正在生成挑战并等待模型返回样本。</Text></Space></Card>}
          {scan?.status === 'failed' && <Alert type="error" showIcon message={scan.error || '检测任务失败'} />}
          {result && <Space orientation="vertical" size={16} className="fingerprint-results">
            <Card title={<Space>检测结论{decision && <Tag color={decision.color}>{decision.label}</Tag>}</Space>}>
              {(scanError || result.error) && <Alert type="warning" showIcon message={result.error || scanError} />}
              {result.prediction_name && <Title level={3}>{result.prediction_name}</Title>}
              {result.family_prediction_name && <Text type="secondary">模型系列候选：{result.family_prediction_name}</Text>}
              <Space wrap className="fingerprint-summary">
                <Badge status="processing" text={`有效样本 ${result.samples.filter((sample) => ['complete', 'truncated'].includes(sample.state)).length}/${result.samples.length}`} />
                <Tag>参考数据 {result.reference_built_at || '未知版本'}</Tag>
                {result.probability != null && <Tag color="blue">参考库内概率 {(result.probability * 100).toFixed(1)}%</Tag>}
                {result.probability_status && <Text type="secondary">概率状态：{result.probability_status}</Text>}
              </Space>
              {result.evidence && <Alert className="fingerprint-evidence" type={result.evidence.insufficient ? 'warning' : 'info'} showIcon message={result.evidence.label} description={result.evidence.reason} />}
              <Text type="secondary">{result.disclaimer}</Text>
            </Card>
            <Card title="挑战样本">
              <List dataSource={result.samples} renderItem={(sample, index) => <List.Item>
                <Space className="sample-row" wrap>
                  <Text strong>样本 {index + 1}</Text>
                  <Tag>{sample.state}</Tag>
                  <Text>{sample.count}/{sample.expected_count} 个有效整数</Text>
                  {sample.first_byte_ms != null && <Text type="secondary">首字节 {sample.first_byte_ms} ms</Text>}
                  {sample.response_model && <Text type="secondary">响应模型：{sample.response_model}</Text>}
                  {sample.error && <Text type="danger">{sample.error}</Text>}
                </Space>
              </List.Item>} />
            </Card>
            <Card title="参考库候选排名">
              {candidates.length ? <Table<CandidateRow> size="small" pagination={{ pageSize: 8, showSizeChanger: false }} columns={columns} dataSource={candidates} scroll={{ x: 620 }} /> : <Text type="secondary">当前样本没有形成可用排名。</Text>}
              <Text type="secondary">排名分数用于库内排序，不应解释成模型身份概率。概率不可用时，SDK 会明确返回不可用状态。</Text>
            </Card>
          </Space>}
        </Col>
      </Row>
    </Content>
    <Footer className="app-footer">Fingerpoint Detector 是有限参考库的模型指纹候选识别，不构成模型身份或服务可信度证明。</Footer>
  </Layout>
}
