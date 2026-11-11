import type { APIClient, ExecutionLocation } from '../../api'
import { CloudOutlined, DesktopOutlined, PlayCircleOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Form, InputNumber, Layout, Select, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, createScan, discoverModels, getEvaluators, getProviders, getScan, listScans, type Connection } from '../../api'
import { defaultEvaluatorIDs } from '../../evaluatorCatalog'
import { detectBrowser } from '../../vendor/fingerpoint/browser'
import { mergeLocal } from '../../data/local'
import type { AppPage, Evaluator, FingerprintDetails, ModelResult, Provider, Scan } from '../../types'
import ModelAPIs, { protocolLabels } from './ModelAPIs'
import Results from './Results'
import type { SavedModelService } from './savedServices'

const { Content, Footer } = Layout
const { Text, Title } = Typography

type Props = {
  token: APIClient
  localClient: APIClient
  cloudClient: APIClient
  onExpired: (location?: ExecutionLocation) => void
  onNavigate: (page: AppPage) => void
}

async function discoverBrowserModels(service: SavedModelService) {
  const response = await fetch(`${service.base_url}/models`, { headers: { Accept: 'application/json', Authorization: `Bearer ${service.api_key}` } })
  let payload: unknown
  try { payload = await response.json() } catch { throw new Error(`浏览器直连模型发现失败（HTTP ${response.status}）`) }
  if (!response.ok) throw new Error(`浏览器直连模型发现失败（HTTP ${response.status}）；如果接口不允许跨域，请直接指定模型 ID。`)
  const data = typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : payload
  if (!Array.isArray(data)) throw new Error('模型发现接口返回格式无法识别，请直接指定模型 ID。')
  return data.flatMap((item) => typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string' ? [{ id: item.id, name: item.id }] : [])
}

export default function Workbench({ token, localClient, cloudClient, onExpired, onNavigate }: Props) {
  const [service, setService] = useState<SavedModelService>()
  const [providers, setProviders] = useState<Provider[]>([])
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [selectedEngineIDs, setSelectedEngineIDs] = useState<string[]>([])
  const [engineExecution, setEngineExecution] = useState<Record<string, ExecutionLocation>>({})
  const [engineOptions, setEngineOptions] = useState<Record<string, Record<string, string | number>>>({})
  const [scans, setScans] = useState<Scan[]>([])
  const [busy, setBusy] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [revision, setRevision] = useState(0)
  const activeScans = useMemo(() => scans.filter((scan) => scan.status === 'pending' || scan.status === 'running'), [scans])
  const activeScanKey = activeScans.map((scan) => `${scan.source || token.mode}:${scan.id}`).sort().join('|')
  const locked = Boolean(busy) || activeScans.length > 0
  const ready = service && (service.scope === 'all' || service.models.length > 0)

  const handleError = useCallback((err: unknown, location: ExecutionLocation = token.mode) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(location); return }
    setError(err instanceof Error ? err.message : '请求失败')
  }, [onExpired, token.mode])

  const updateScan = useCallback((item: Scan) => {
    setScans((current) => [item, ...current.filter((previous) => `${previous.source || token.mode}:${previous.id}` !== `${item.source || token.mode}:${item.id}`)].sort((a, b) => b.created_at.localeCompare(a.created_at)))
  }, [token.mode])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([getProviders(token, controller.signal), getEvaluators(token, controller.signal), listScans(token, controller.signal, { local: localClient, cloud: cloudClient })])
      .then(([providerResponse, evaluatorResponse, scanResponse]) => {
        if (controller.signal.aborted) return
        setProviders(providerResponse.providers)
        setEngines(evaluatorResponse.evaluators)
        setSelectedEngineIDs(defaultEvaluatorIDs(evaluatorResponse.evaluators))
        setEngineExecution((current) => Object.fromEntries(evaluatorResponse.evaluators.map((engine) => [engine.id, current[engine.id] || (token.mode === 'cloud' ? 'cloud' : 'local')])))
        setScans(scanResponse.scans)
        setLoaded(true)
      }).catch((err: unknown) => { if (!controller.signal.aborted) handleError(err) })
    return () => controller.abort()
  }, [cloudClient, handleError, localClient, revision, token])

  useEffect(() => {
    if (!activeScans.length) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setPollError('')
    async function poll() {
      try {
        const updates = await Promise.all(activeScans.map((scan) => getScan(scan.source === 'cloud' ? cloudClient : localClient, scan.id, controller.signal)))
        if (controller.signal.aborted) return
        setScans((current) => {
          const byKey = new Map(current.map((item) => [`${item.source || token.mode}:${item.id}`, item]))
          updates.forEach((item) => byKey.set(`${item.source || token.mode}:${item.id}`, item))
          return [...byKey.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
        })
        if (updates.some((item) => item.status === 'pending' || item.status === 'running')) timer = setTimeout(poll, 1200)
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) onExpired('cloud')
        else setPollError(err instanceof Error ? err.message : '无法读取任务进度')
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [activeScanKey, cloudClient, localClient, onExpired, token.mode])

  async function runBrowserFingerprint(modelID: string, selected: SavedModelService, options: Record<string, string | number> | undefined, engine: Evaluator): Promise<ModelResult> {
    const result = await detectBrowser({ baseUrl: selected.base_url, apiKey: selected.api_key, model: modelID, protocol: selected.protocol, count: Number(options?.count || 3), strict: Boolean(options?.strict) })
    const analysis = result.analysis
    const details: FingerprintDetails = {
      decision: analysis.decision, prediction: analysis.prediction, prediction_name: analysis.prediction_name,
      family_prediction_name: analysis.family_prediction_name, probability: analysis.probability,
      probability_scope: null, ranking_score: analysis.ranking_score ?? null,
      candidates: analysis.results.map((item) => ({ model: item.model, display_name: item.display_name, family: item.family, family_name: item.family_name, score: item.score, probability: item.probability })),
      samples: result.samples, reference_built_at: result.reference_built_at, model_version: result.model_version,
      evidence: analysis.evidence, disclaimer: '本地浏览器 Fingerpoint 检测；结果仅在参考库内比较，不是身份确认。',
    }
    return { model: { id: modelID, name: modelID }, status: 'completed', report: { checks: [], kind: engine.id, details } }
  }

  function locationFor(engine: Evaluator): ExecutionLocation {
    return engineExecution[engine.id] || (token.mode === 'cloud' ? 'cloud' : 'local')
  }

  async function start() {
    if (!service || !selectedEngineIDs.length || !ready) return
    setBusy('start'); setError('')
    try {
      for (const engine of engines.filter((item) => selectedEngineIDs.includes(item.id))) {
        const location = locationFor(engine)
        const execution = location === 'local' ? localClient : cloudClient
        if (location === 'cloud' && !cloudClient.token) throw new Error(`${engine.name} 选择云端执行时需要先登录云端。`)
        if (location === 'local' && service.source === 'cloud') throw new Error('云端保存的 API Key 不会回传浏览器，不能选择本地执行；请切换云端执行或新建本地 API。')
        const connection: Connection = { service_id: location === 'cloud' && service.source === 'cloud' ? service.id : undefined, vendor: service.vendor, service_name: service.name, protocol: service.protocol, base_url: service.base_url, api_key: service.api_key }
        let discoveredIDs: string[] = []
        if (service.scope === 'all' && engine.requires_explicit_models) {
          const models = location === 'local' ? await discoverBrowserModels(service) : (await discoverModels(execution, connection)).models
          if (!models.length) throw new Error('该 API 返回了空模型列表，请编辑配置并指定模型 ID。')
          discoveredIDs = models.map((model) => model.id)
        }
        const requestScope = service.scope === 'all' && engine.requires_explicit_models ? 'selected' : service.scope
        const requestModels = service.scope === 'selected' ? service.models : engine.requires_explicit_models ? discoveredIDs : []
        if (location === 'local' && engine.id === 'fingerprint') {
          const createdAt = new Date().toISOString()
          const modelResults: ModelResult[] = []
          for (const modelID of requestModels) {
            try { modelResults.push(await runBrowserFingerprint(modelID, service, engineOptions[engine.id], engine)) }
            catch (err) { modelResults.push({ model: { id: modelID, name: modelID }, status: 'error', report: { checks: [], kind: engine.id }, error: err instanceof Error ? err.message : '浏览器直连 Fingerpoint 失败' }) }
          }
          const item: Scan = { id: `local-scan-${crypto.randomUUID()}`, source: 'local', status: modelResults.some((item) => item.status === 'error') ? 'completed_with_errors' : 'completed', vendor: service.vendor, service_name: service.name, evaluator: engine, scope: requestScope, models: modelResults, created_at: createdAt, completed_at: new Date().toISOString() }
          setScans((current) => [item, ...current])
          await mergeLocal('scans', [item])
          continue
        }
        const item = await createScan(execution, { ...connection, scope: requestScope, models: requestModels, evaluator: engine.id, evaluator_options: engine.id === 'fingerprint' ? { ...engineOptions[engine.id], api: service.protocol } : engineOptions[engine.id] })
        updateScan(item)
      }
    } catch (err) { handleError(err, engineExecution[selectedEngineIDs[0]] || token.mode) }
    finally { setBusy('') }
  }

  const selectService = useCallback((next: SavedModelService | undefined) => {
    setService(next)
    if (next?.source === 'cloud') setEngineExecution((current) => Object.fromEntries(engines.map((engine) => [engine.id, current[engine.id] === 'local' ? 'cloud' : current[engine.id] || 'cloud'])))
  }, [engines])

  const cloudExecutionSelected = engines.some((engine) => selectedEngineIDs.includes(engine.id) && locationFor(engine) === 'cloud')
  const localServiceCloudWarning = cloudExecutionSelected && service?.source === 'local'

  return <Layout className="app-layout">
    <Content className="app-content scan-content">
      <div className="page-heading"><Title level={1}>首页</Title><Text type="secondary">管理模型 API，选择巡检引擎和执行位置，再查看合并后的结果。</Text></div>
      {error && <Alert title={error} type="error" showIcon closable onClose={() => setError('')} action={(!providers.length || !engines.length) && <Button type="link" icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>重新加载</Button>} />}
      <ModelAPIs token={token} defaultVendor={providers[0]?.id || ''} locked={Boolean(busy)} onExpired={() => onExpired(token.mode)} onSelect={selectService} />
      <Card title={<Space><ThunderboltOutlined />巡检引擎</Space>} className="scan-engine-panel" loading={!loaded && !error}>
        <Space wrap className="scan-target-summary">
          <Text type="secondary">当前模型 API</Text><Text strong>{service?.name || '请在上方添加并选择 API'}</Text>
          {service && <><Tag color={service.source === 'cloud' ? 'blue' : 'default'}>{service.source === 'cloud' ? '云端配置' : '本地配置'}</Tag><Tag>{protocolLabels[service.protocol]}</Tag><Tag>{service.scope === 'all' ? '全部模型' : `指定 ${service.models.length} 个模型`}</Tag></>}
        </Space>
        {service?.scope === 'selected' && !service.models.length && <Alert type="warning" showIcon title="此 API 尚未配置巡检模型" description="请点击上方“编辑”，指定模型 ID 或选择全部模型。" />}
        {localServiceCloudWarning && <Alert type="warning" showIcon title="当前选择了云端执行" description="这会把当前本地 API Key 随检测请求发送到云端服务器。只有明确选择云端执行时才会发生。" />}
        <Form layout="vertical" requiredMark={false}>
          <Form.Item label="选择引擎" extra="可同时选择多个引擎；每个引擎单独选择本地或云端执行。">
            <Checkbox.Group disabled={locked} value={selectedEngineIDs} onChange={(values) => setSelectedEngineIDs(values.map(String))} options={engines.map((engine) => ({ label: engine.name, value: engine.id }))} />
          </Form.Item>
          {engines.filter((engine) => selectedEngineIDs.includes(engine.id)).map((engine) => <Card key={engine.id} size="small" title={engine.name} className="inspection-engine-options" extra={<Select aria-label={`${engine.name}执行位置`} size="small" value={locationFor(engine)} disabled={locked || (locationFor(engine) === 'cloud' && !cloudClient.token)} onChange={(value) => setEngineExecution((current) => ({ ...current, [engine.id]: value }))} options={[{ value: 'local', label: <Space size={4}><DesktopOutlined />本地执行</Space>, disabled: service?.source === 'cloud' }, { value: 'cloud', label: <Space size={4}><CloudOutlined />云端执行</Space>, disabled: !cloudClient.token }]} />}>
            {engine.options?.map((option) => {
              const value = engineOptions[engine.id]?.[option.key] ?? option.default
              const change = (next: string | number) => setEngineOptions((current) => ({ ...current, [engine.id]: { ...current[engine.id], [option.key]: next } }))
              return <Form.Item key={option.key} label={option.label}>
                {option.kind === 'select' ? <Select aria-label={`${engine.name} ${option.label}`} disabled={locked} value={value} options={option.choices} onChange={change} /> : <InputNumber aria-label={`${engine.name} ${option.label}`} disabled={locked} value={value} min={option.min} max={option.max} precision={0} onChange={(next) => { if (next !== null) change(next) }} />}
              </Form.Item>
            })}
            {!engine.options?.length && <Text type="secondary">此引擎没有额外参数。</Text>}
          </Card>)}
          <Space orientation="vertical" size={4} className="engine-descriptions">{engines.filter((engine) => selectedEngineIDs.includes(engine.id)).map((engine) => <Text type="secondary" key={engine.id}>{engine.name}：{engine.description}</Text>)}</Space>
          <div className="scan-start-action"><Button type="primary" icon={<PlayCircleOutlined />} loading={busy === 'start'} disabled={!loaded || locked || !ready || !selectedEngineIDs.length} onClick={() => void start()}>
            {activeScans.length ? `正在运行 ${activeScans.length} 项任务…` : `开始巡检 · ${selectedEngineIDs.length} 个引擎`}
          </Button><Text type="secondary">开始巡检将向所选 API 发起真实模型请求。</Text></div>
        </Form>
      </Card>
      {pollError && <Alert title={`进度读取已暂停：${pollError}`} type="error" showIcon action={<Button type="link" onClick={() => setRevision((value) => value + 1)}>重试读取</Button>} />}
      <Results scans={scans} engines={engines} />
    </Content>
    <Footer className="app-footer">本地配置与结果保存在浏览器；云端配置和结果保存在当前账号。每个巡检引擎的执行位置独立生效。</Footer>
  </Layout>
}
