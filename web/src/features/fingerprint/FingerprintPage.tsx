import { PlayCircleOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { Alert, AutoComplete, Button, Card, Col, Collapse, Form, Input, InputNumber, Layout, Row, Space, Switch, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { connectionFor, getCatalog, listScans, type APIClient } from '../../api'
import { SourceTag, useLocations, useSourceData } from '../../app/Locations'
import { recordKey } from '../../data/sources'
import type { Evaluator, FingerprintDetails, Scan } from '../../types'
import { generateChallenges, type Challenge } from '../../vendor/fingerpoint/browser'
import { emptySamples } from '../../vendor/fingerpoint/sampleEvidence'
import { executeEngine } from '../scans/execution'
import ModelAPISelector, { modelServiceKey } from '../scans/ModelAPISelector'
import { protocolLabels } from '../scans/ModelAPIEditor'
import type { SavedModelService } from '../scans/savedServices'
import type { LogNavigation } from '../logs/records'
import FingerprintSampleCard from './FingerprintSampleCard'

const { Content, Footer } = Layout
const { Text, Title } = Typography
type FormValues = { model: string; strict: boolean; timeout_seconds: number }
const decisions: Record<string, { label: string; color: string }> = {
  scored: { label: '完整排名', color: 'success' }, partial: { label: '部分样本排名', color: 'warning' },
  unscorable: { label: '样本不足', color: 'default' }, not_model: { label: '回答不像语言模型', color: 'error' },
}
type CandidateRow = FingerprintDetails['candidates'][number] & { key: string; rank: number }
const columns: ColumnsType<CandidateRow> = [
  { title: '排名', dataIndex: 'rank', width: 72 },
  { title: '候选模型', dataIndex: 'display_name', render: (name: string, row) => <Space orientation="vertical" size={0}><Text strong>{name || row.model}</Text><Text type="secondary">{row.model}</Text></Space> },
  { title: '系列', dataIndex: 'family_name', render: (name: string, row) => name || row.family || '—' },
  { title: '排名分数', dataIndex: 'score', align: 'right', render: (value: number) => value.toFixed(6) },
  { title: '参考库概率', dataIndex: 'probability', align: 'right', render: (value: number | null) => value == null ? '不可用' : `${(value * 100).toFixed(1)}%` },
]
const loadFingerprintScans = (client: APIClient, signal: AbortSignal) => listScans(client, signal).then((data) => data.scans.filter((scan) => scan.evaluator.id === 'fingerprint'))

export default function FingerprintPage({ onOpenLogs }: LogNavigation) {
  const [form] = Form.useForm<FormValues>()
  const model = Form.useWatch('model', form)
  const { choose, owner, changed } = useLocations()
  const { items: records, errors, refresh } = useSourceData(loadFingerprintScans, 3000)
  const [engine, setEngine] = useState<Evaluator | null>(null)
  const [service, setService] = useState<SavedModelService>()
  const [configOpen, setConfigOpen] = useState(true)
  const [challenges, setChallenges] = useState<Challenge[]>(() => generateChallenges(3))
  const [liveSamples, setLiveSamples] = useState<FingerprintDetails['samples']>(() => emptySamples(challenges))
  const [selectedID, setSelectedID] = useState<string>()
  const [submitted, setSubmitted] = useState<Scan>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const scan = selectedID ? records.find((item) => recordKey(item) === selectedID) || (submitted && recordKey(submitted) === selectedID ? submitted : undefined) : undefined
  const active = busy || scan?.status === 'running' || scan?.status === 'pending'
  const report = scan?.models[0]?.report
  const result = report?.kind === 'fingerprint' ? report.details as FingerprintDetails | undefined : undefined
  const samples = result?.samples.length ? result.samples : liveSamples.map((sample) => scan?.status === 'failed' || scan?.models[0]?.status === 'error' ? { ...sample, state: 'failed', error: scan.error || scan.models[0]?.error || '执行失败' } : sample)
  const scanError = scan?.error || scan?.models[0]?.error
  const decision = result?.decision ? decisions[result.decision] || { label: result.decision, color: 'default' } : undefined
  const candidates: CandidateRow[] = (result?.candidates || []).map((candidate, index) => ({ ...candidate, key: candidate.model, rank: index + 1 }))

  function clearRound(next = challenges) {
    setSelectedID(undefined); setSubmitted(undefined); setError(''); setLiveSamples(emptySamples(next))
  }
  const selectService = useCallback((next: SavedModelService | undefined) => {
    setService(next); form.setFieldValue('model', next?.models[0] || '')
    setSelectedID(undefined); setSubmitted(undefined); setLiveSamples(emptySamples(challenges)); setError('')
  }, [form, challenges])
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    getCatalog(controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setEngine(catalog.evaluators.find((item) => item.id === 'fingerprint') || null)
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '加载引擎失败')
    })
    return () => { controller.abort(); mounted.current = false }
  }, [])

  function newChallenges() {
    const next = generateChallenges(3)
    setChallenges(next); clearRound(next)
  }
  async function submit(values: FormValues) {
    if (!service || !engine || active) return
    setBusy(true); setError('')
    try {
      const target = await choose({ action: 'execute', title: '指纹检测在哪里执行？', from: service.source })
      if (!target || !mounted.current) return
      const connection = await connectionFor(service, owner(service.source), target)
      if (!mounted.current) return
      clearRound(); setConfigOpen(false)
      setLiveSamples(emptySamples(challenges).map((sample) => ({ ...sample, state: 'waiting' })))
      const created = await executeEngine(target, connection, engine, 'selected', [values.model.trim()], {
        count: 3, strict: values.strict, timeout_seconds: values.timeout_seconds, challenges,
      }, (updates) => { if (mounted.current) setLiveSamples(updates) })
      if (!mounted.current) return
      setSubmitted(created); setSelectedID(recordKey(created)); changed(); refresh()
    } catch (err) {
      if (!mounted.current) return
      const reason = err instanceof Error ? err.message : '指纹检测失败'
      setError(reason)
      setLiveSamples((current) => current.map((sample) => ['waiting', 'queued', 'streaming'].includes(sample.state) ? { ...sample, state: 'failed', error: reason } : sample))
    } finally { if (mounted.current) setBusy(false) }
  }

  return <Layout className="engine-embedded-layout">
    <Content className="app-content fingerprint-content fingerprint-workbench">
      <div className="fingerprint-page-heading"><Title level={2}>指纹检测</Title><Text type="secondary">查看三条提示词，采集模型回复并分析指纹。</Text></div>
      {error && <Alert title={error} type="error" showIcon closable onClose={() => setError('')} />}
      <Collapse className="fingerprint-api-strip" activeKey={configOpen ? ['api'] : []} onChange={(keys) => setConfigOpen(keys.includes('api'))} expandIconPlacement="end" items={[{
        key: 'api', label: <div className="fingerprint-api-summary"><span className="fingerprint-config-icon"><SettingOutlined /></span><Text className="fingerprint-endpoint">{service?.base_url || '选择或新增模型 API'}</Text><Text type="secondary">/</Text><Text className="fingerprint-model">{model || '指定检测模型'}</Text>{service && <SourceTag source={service.source} />}</div>,
        children: <>
          <ModelAPISelector value={modelServiceKey(service)} onChange={selectService} disabled={Boolean(active)} />
          <Form name="fingerprint" form={form} layout="vertical" requiredMark={false} initialValues={{ model: '', strict: true, timeout_seconds: 120 }} onFinish={submit} disabled={Boolean(active)} onValuesChange={() => clearRound()}>
            <Row gutter={[20, 0]}>
              <Col xs={24} md={12}><Form.Item name="model" label="目标模型 ID" rules={[{ required: true, whitespace: true, message: '请输入模型 ID' }]}><AutoComplete placeholder="输入或选择模型 ID" options={service?.models.map((id) => ({ value: id }))} /></Form.Item></Col>
              <Col xs={24} md={12}><Form.Item label="请求协议"><Input readOnly value={service ? protocolLabels[service.protocol] : ''} placeholder="从已保存 API 读取" /></Form.Item></Col>
              <Col xs={24} md={12}><Form.Item name="timeout_seconds" label="请求超时（秒）" rules={[{ required: true }]}><InputNumber min={1} max={3600} precision={0} /></Form.Item></Col>
              <Col xs={24} md={12}><Form.Item name="strict" label="严格模式" valuePropName="checked" extra="要求三条有效样本，关闭后允许部分样本排名。"><Switch /></Form.Item></Col>
            </Row>
          </Form>
        </>,
      }]} />

      <div className="fingerprint-samples-grid">
        {samples.length ? samples.map((sample, index) => <FingerprintSampleCard key={`${selectedID || 'new'}:${sample.challenge_id}:${index}`} sample={sample} index={index} />) : <Alert type="info" showIcon title="此历史任务没有样本数据" description="点击“换一组提示词”开始新一轮。" />}
      </div>
      {scanError && <Alert type="error" showIcon title={scanError} />}
      <div className="fingerprint-round-actions"><Text type="secondary">{active ? '正在取样与分析，云端 / Worker 的回复会在任务完成后显示。' : '三条提示词独立取样；仅在点击开始后调用模型。'}</Text><Space wrap>
        <Button icon={<ReloadOutlined />} disabled={Boolean(active)} onClick={newChallenges}>换一组提示词</Button>
        <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} disabled={!engine || !service || Boolean(active)} onClick={() => { if (!model?.trim()) setConfigOpen(true); form.submit() }}>{active ? '取样中…' : '开始取样'}</Button>
      </Space></div>

      {result && <Card className="fingerprint-ranking" title="参考库候选排名" extra={decision && <Tag color={decision.color}>{decision.label}</Tag>}>
        <Space wrap className="fingerprint-summary">{candidates.length > 0 && result.prediction_name && <Text strong>最相似候选：{result.prediction_name}</Text>}{result.probability != null && <Tag color="blue">参考库内概率 {(result.probability * 100).toFixed(1)}%</Tag>}{scan && <SourceTag source={scan.source} />}<Text type="secondary">参考数据 {result.reference_built_at || '未加载'}</Text></Space>
        {result.error && <Alert showIcon type="warning" title={result.error} />}
        {result.evidence && <Alert showIcon type={result.evidence.insufficient ? 'warning' : 'info'} title={result.evidence.label} description={result.evidence.reason} />}
        <Table<CandidateRow> size="small" rowKey="key" columns={columns} dataSource={candidates} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 620 }} locale={{ emptyText: '当前样本没有形成可用排名' }} />
      </Card>}
      {scan && <Button onClick={() => onOpenLogs({ kind: 'scan', id: scan.id, source: scan.source })}>在巡检日志中查看详情</Button>}
      {errors.map((message) => <Alert key={message} type="warning" title={message} action={<Button onClick={refresh}>重试</Button>} />)}
    </Content>
    <Footer className="app-footer">指纹排名只在有限参考库内比较，不构成模型身份认证。首次分析需下载参考数据；取样会消耗模型额度。</Footer>
  </Layout>
}
