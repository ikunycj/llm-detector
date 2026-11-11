import type { AppPage } from '../../types'
import {
  ApiOutlined,
  DeleteOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { Alert, Badge, Button, Card, Checkbox, Col, Form, Input, InputNumber, Layout, List, Popconfirm, Radio, Row, Segmented, Select, Space, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, createScan, discoverModels, getEvaluators, getProviders, getScan, listScans, logout, type Connection } from '../../api'
import { defaultEvaluatorIDs, explicitModelEvaluatorIDs } from '../../evaluatorCatalog'
import type { Evaluator, Model, Provider, Scan } from '../../types'
import Results from './Results'
import { readSavedServices, writeSavedServices, type SavedModelService } from './savedServices'

const { Content, Footer, Header } = Layout
const { Text, Title } = Typography
const emptyConnection: Connection = { vendor: '', service_name: '', protocol: 'chat_completions', base_url: '', api_key: '' }

export default function Workbench({ token, onExpired, onLogout, onNavigate }: { token: string; onExpired: () => void; onLogout: () => void; onNavigate: (page: AppPage) => void }) {
  const [connection, setConnection] = useState<Connection>(emptyConnection)
  const [providers, setProviders] = useState<Provider[]>([])
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [selectedEngineIDs, setSelectedEngineIDs] = useState<string[]>([])
  const [engineOptions, setEngineOptions] = useState<Record<string, Record<string, string | number>>>({})
  const [models, setModels] = useState<Model[]>([])
  const [discovered, setDiscovered] = useState(false)
  const [scope, setScope] = useState<'all' | 'selected'>('selected')
  const [modelText, setModelText] = useState('')
  const [scans, setScans] = useState<Scan[]>([])
  const [savedServices, setSavedServices] = useState<SavedModelService[]>([])
  const [serviceName, setServiceName] = useState('')
  const [activeServiceID, setActiveServiceID] = useState('')
  const [busy, setBusy] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [revision, setRevision] = useState(0)
  const selectedModels = [...new Set(modelText.split(/[\s,，]+/).filter(Boolean))]
  const activeScanIDs = useMemo(() => scans.filter((scan) => scan.status === 'pending' || scan.status === 'running').map((scan) => scan.id).sort(), [scans])
  const activeScanKey = activeScanIDs.join('|')
  const locked = Boolean(busy) || activeScanIDs.length > 0
  const ready = Boolean(connection.vendor && connection.base_url.trim() && connection.api_key.trim())
  const explicitModelEngineIDs = useMemo(() => explicitModelEvaluatorIDs(engines), [engines])
  const selectedExplicitModelEngines = useMemo(() => engines.filter((engine) => selectedEngineIDs.includes(engine.id) && engine.requires_explicit_models), [engines, selectedEngineIDs])

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(); return }
    setError(err instanceof Error ? err.message : '请求失败')
  }, [onExpired])

  const updateScan = useCallback((item: Scan) => {
    setScans((current) => [item, ...current.filter((previous) => previous.id !== item.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([getProviders(token, controller.signal), getEvaluators(token, controller.signal), listScans(token, controller.signal)])
      .then(([providerResponse, evaluatorResponse, scanResponse]) => {
        if (controller.signal.aborted) return
        setProviders(providerResponse.providers)
        setEngines(evaluatorResponse.evaluators)
        setSelectedEngineIDs(defaultEvaluatorIDs(evaluatorResponse.evaluators))
        setConnection((current) => ({ ...current, vendor: current.vendor || providerResponse.providers[0]?.id || '' }))
        setScans(scanResponse.scans)
        try { setSavedServices(readSavedServices()) }
        catch (storageError) { setError(storageError instanceof Error ? storageError.message : '无法读取浏览器保存的模型服务') }
        setLoaded(true)
      }).catch((err: unknown) => { if (!controller.signal.aborted) handleError(err) })
    return () => controller.abort()
  }, [token, handleError, revision])

  useEffect(() => {
    if (!activeScanIDs.length) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setPollError('')
    async function poll() {
      try {
        const updates = await Promise.all(activeScanIDs.map((id) => getScan(token, id, controller.signal)))
        if (controller.signal.aborted) return
        setScans((current) => {
          const byID = new Map(current.map((item) => [item.id, item]))
          updates.forEach((item) => byID.set(item.id, item))
          return [...byID.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
        })
        if (updates.some((item) => item.status === 'pending' || item.status === 'running')) timer = setTimeout(poll, 1200)
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) onExpired()
        else setPollError(err instanceof Error ? err.message : '无法读取任务进度')
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [activeScanKey, token, onExpired, revision])

  function updateConnection(field: keyof Connection, value: string) {
    setConnection((current) => ({ ...current, [field]: value }))
    setModels([])
    setDiscovered(false)
    setModelText('')
    setError('')
  }

  function chooseService(id: string) {
    const service = savedServices.find((item) => item.id === id)
    if (!service) return
    setActiveServiceID(service.id)
    setServiceName(service.name)
    setConnection({ vendor: service.vendor, service_name: service.name, protocol: service.protocol, base_url: service.base_url, api_key: service.api_key })
    setModels([])
    setDiscovered(false)
    setModelText('')
    setError('')
  }

  function persistServices(next: SavedModelService[]) {
    try {
      writeSavedServices(next)
      setSavedServices(next)
      setError('')
    } catch {
      setError('浏览器无法保存配置，请检查本地存储空间或隐私设置。')
    }
  }

  function saveService() {
    const name = serviceName.trim()
    if (!name || !ready) {
      setError('请填写服务名称、Base URL 和 API Key 后再保存。')
      return
    }
    const current = savedServices.find((service) => service.id === activeServiceID)
    const item: SavedModelService = {
      id: current?.id || crypto.randomUUID(),
      name,
      vendor: connection.vendor,
      service_name: name,
      protocol: connection.protocol,
      base_url: connection.base_url.trim(),
      api_key: connection.api_key,
      updated_at: new Date().toISOString(),
    }
    persistServices([item, ...savedServices.filter((service) => service.id !== item.id)])
    setActiveServiceID(item.id)
  }

  function deleteService() {
    const next = savedServices.filter((service) => service.id !== activeServiceID)
    persistServices(next)
    setActiveServiceID('')
    setServiceName('')
  }

  async function discover() {
    setBusy('discover'); setError('')
    try {
      const result = await discoverModels(token, connection)
      setModels(result.models)
      setDiscovered(true)
      setModelText('')
    } catch (err) { handleError(err) }
    finally { setBusy('') }
  }

  async function start() {
    if (!selectedEngineIDs.length) {
      setError('至少选择一个巡检引擎。')
      return
    }
    if (scope === 'selected' && !selectedModels.length) {
      setError('请输入或选择至少一个模型 ID。')
      return
    }

    setBusy('start')
    setError('')
    try {
      let allModelIDs: string[] = []
      if (scope === 'all' && selectedExplicitModelEngines.length) {
        const discoveredModels = discovered ? models : (await discoverModels(token, connection)).models
        if (!discoveredModels.length) throw new Error('所选巡检引擎需要明确的模型 ID，但模型发现接口返回了空列表。')
        allModelIDs = discoveredModels.map((model) => model.id)
        setModels(discoveredModels)
        setDiscovered(true)
      }

      for (const evaluatorID of selectedEngineIDs) {
        const requiresExplicitModels = explicitModelEngineIDs.has(evaluatorID)
        const requestScope = scope === 'all' && requiresExplicitModels ? 'selected' : scope
        const requestModels = scope === 'selected' ? selectedModels : requiresExplicitModels ? allModelIDs : []
        const item = await createScan(token, {
          ...connection,
          service_name: serviceName.trim() || connection.base_url.trim(),
          scope: requestScope,
          models: requestModels,
          evaluator: evaluatorID,
          evaluator_options: engineOptions[evaluatorID],
        })
        updateScan(item)
      }
    } catch (err) { handleError(err) }
    finally { setBusy('') }
  }

  async function signOut() {
    setBusy('logout'); setError('')
    try { await logout(token); onLogout() }
    catch (err) { handleError(err) }
    finally { setBusy('') }
  }

  function toggleModel(id: string) {
    setModelText((current) => {
      const selected = [...new Set(current.split(/[\s,，]+/).filter(Boolean))]
      return (selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]).join('\n')
    })
  }

  return <Layout className="app-layout">
    <Header className="app-header">
      <Space className="brand" size={12}><span className="brand-mark" aria-hidden="true">L</span><Text strong>LLM Intelligence</Text><Text type="secondary">/ 巡检工作台</Text></Space>
      <Space>
        <Segmented value="scan" onChange={(value) => onNavigate(value as AppPage)} options={[{ label: '模型巡检', value: 'scan' }, { label: '巡检任务', value: 'tasks' }, { label: '巡检引擎', value: 'engines' }]} />
        <Button type="text" icon={<LogoutOutlined />} onClick={() => void signOut()} loading={busy === 'logout'}>退出登录</Button>
      </Space>
    </Header>
    <Content className="app-content">
      <div className="page-heading"><Title level={1}>模型智力巡检</Title><Text type="secondary">连接模型服务，选择一个或多个引擎批量检测。</Text></div>
      {error && <Alert message={error} type="error" showIcon closable onClose={() => setError('')} action={(!providers.length || !engines.length) && <Button type="link" icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>重新加载</Button>} />}
      <Row gutter={[20, 20]} align="stretch" className="workspace-grid">
        <Col xs={24} lg={9}>
          <Card title={<Space><ApiOutlined />模型服务</Space>} extra={<Text type="secondary">{savedServices.length} 项已保存</Text>} className="workspace-card">
            <Form layout="vertical" requiredMark={false}>
              <Form.Item label="已保存服务">
                <Select allowClear value={activeServiceID || undefined} placeholder="选择本地保存的模型服务" onChange={chooseService} options={savedServices.map((service) => ({ value: service.id, label: service.name }))} />
              </Form.Item>
              <Form.Item label="服务名称" extra="用于巡检结果筛选；未保存时会使用 Base URL 作为服务名称。">
                <Input value={serviceName} onChange={(event) => { setServiceName(event.target.value); setConnection((current) => ({ ...current, service_name: event.target.value })) }} placeholder="例如：生产网关 / 研发代理" />
              </Form.Item>
                <Form.Item label="厂商适配器">
                <Select disabled={locked} value={connection.vendor || undefined} placeholder="正在加载…" onChange={(value) => updateConnection('vendor', value)} options={providers.map((provider) => ({ value: provider.id, label: provider.name }))} />
              </Form.Item>
              <Form.Item label="模型协议" extra="支持 OpenAI Chat Completions 和 Anthropic Messages。">
                <Select disabled={locked} value={connection.protocol} onChange={(value) => updateConnection('protocol', value)} options={[{ value: 'chat_completions', label: 'Chat Completions' }, { value: 'messages', label: 'Messages' }]} />
              </Form.Item>
              <Form.Item label="API Base URL">
                <Input disabled={locked} type="url" value={connection.base_url} onChange={(event) => updateConnection('base_url', event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" />
              </Form.Item>
              <Form.Item label="模型 API Key">
                <Input.Password disabled={locked} value={connection.api_key} onChange={(event) => updateConnection('api_key', event.target.value)} autoComplete="off" />
              </Form.Item>
              <Alert type="warning" showIcon message="保存配置会将 API Key 明文存入当前浏览器的 localStorage。仅在个人受信任设备上保存；其他有权访问此浏览器配置的本机用户或同源脚本可能读取它。" />
              <Space wrap>
                <Button icon={<SaveOutlined />} disabled={!ready || !serviceName.trim()} onClick={saveService}>{activeServiceID ? '更新已保存服务' : '保存到本机'}</Button>
                {activeServiceID && <Popconfirm title="删除此浏览器中的服务配置？" description="只删除本机保存的数据，不会撤销模型 API Key。" onConfirm={deleteService} okText="删除" cancelText="取消"><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm>}
                <Button icon={<PlusOutlined />} onClick={() => { setActiveServiceID(''); setServiceName(''); setConnection(emptyConnection) }}>新建配置</Button>
              </Space>
              <Button block className="discover-button" icon={<SearchOutlined />} loading={busy === 'discover'} disabled={locked || !ready} onClick={() => void discover()}>发现可用模型</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card title={<Space><ThunderboltOutlined />配置巡检范围</Space>} extra={discovered && <Badge color="#4359d7" text={`发现 ${models.length} 个模型`} />} className="workspace-card">
            <Form layout="vertical" requiredMark={false}>
              <Form.Item label="巡检范围">
                <Radio.Group disabled={locked} value={scope} onChange={(event) => setScope(event.target.value)} optionType="button" buttonStyle="solid" options={[{ label: '指定模型', value: 'selected' }, { label: '全部模型', value: 'all' }]} />
              </Form.Item>
              {scope === 'selected' ? <Form.Item label="模型 ID" extra="每行一个 ID，也可用逗号分隔；指定模型不依赖 /models 发现接口。">
                <Input.TextArea disabled={locked} rows={3} value={modelText} onChange={(event) => setModelText(event.target.value)} placeholder="例如：gpt-4.1-mini\nclaude-3-7-sonnet" spellCheck={false} />
              </Form.Item> : <Alert message={selectedExplicitModelEngines.length ? `所选引擎（${selectedExplicitModelEngines.map((engine) => engine.name).join('、')}）需要先发现模型，再按模型 ID 创建任务。` : '任务会重新发现并巡检接口返回的全部模型。'} type={selectedExplicitModelEngines.length ? 'info' : 'warning'} showIcon />}
              {discovered && models.length === 0 && <Alert message="服务返回空列表，可以切换到“指定模型”手动输入 ID。" type="info" showIcon />}
              {models.length > 0 && scope === 'selected' && <div className="model-picker">
                <Space className="model-picker-heading" align="center"><Text type="secondary">从发现结果中选择</Text><Button type="link" size="small" onClick={() => setModelText(models.map((model) => model.id).join('\n'))}>全选列表</Button></Space>
                <List size="small" bordered dataSource={models} renderItem={(model) => <List.Item><Checkbox disabled={locked} checked={selectedModels.includes(model.id)} onChange={() => toggleModel(model.id)}>{model.id}</Checkbox></List.Item>} />
              </div>}
              <Form.Item label="巡检引擎" extra="可同时选择多个引擎；每个引擎会创建独立任务并分别显示结果。">
                <Checkbox.Group disabled={locked} value={selectedEngineIDs} onChange={(values) => setSelectedEngineIDs(values as string[])} options={engines.map((engine) => ({ label: <Space size={4}><Text>{engine.name}</Text></Space>, value: engine.id }))} />
              </Form.Item>
              {engines.filter((engine) => selectedEngineIDs.includes(engine.id) && engine.options?.length).map((engine) => <Card key={engine.id} size="small" title={engine.name} className="inspection-engine-options">
                {engine.options?.map((option) => {
                  const value = engineOptions[engine.id]?.[option.key] ?? option.default
                  const change = (next: string | number) => setEngineOptions((current) => ({ ...current, [engine.id]: { ...current[engine.id], [option.key]: next } }))
                  return <Form.Item key={option.key} label={option.label}>
                    {option.kind === 'select' ? <Select aria-label={`${engine.name} ${option.label}`} disabled={locked} value={value} options={option.choices} onChange={change} /> : <InputNumber aria-label={`${engine.name} ${option.label}`} disabled={locked} value={value} min={option.min} max={option.max} precision={0} onChange={(next) => { if (next !== null) change(next) }} />}
                  </Form.Item>
                })}
              </Card>)}
              <Space direction="vertical" size={4} className="engine-descriptions">{engines.filter((engine) => selectedEngineIDs.includes(engine.id)).map((engine) => <Text type="secondary" key={engine.id}>{engine.name}：{engine.description}</Text>)}</Space>
              <Button type="primary" block icon={<PlayCircleOutlined />} loading={busy === 'start'} disabled={!loaded || locked || !ready || !selectedEngineIDs.length || (scope === 'selected' && !selectedModels.length)} onClick={() => void start()}>
                {activeScanIDs.length ? `正在运行 ${activeScanIDs.length} 项任务…` : `开始巡检 · ${selectedEngineIDs.length} 个引擎`}
              </Button>
            </Form>
          </Card>
        </Col>
      </Row>
      {pollError && <Alert message={`进度读取已暂停：${pollError}`} type="error" showIcon action={<Button type="link" onClick={() => setRevision((value) => value + 1)}>重试读取</Button>} />}
      <Results scans={scans} engines={engines} />
    </Content>
    <Footer className="app-footer">服务配置保存在当前浏览器；巡检任务保存在服务内存，服务重启后清空。</Footer>
  </Layout>
}
