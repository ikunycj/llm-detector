import {
  ApiOutlined,
  CheckOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { Alert, Badge, Button, Card, Checkbox, Col, Empty, Form, Input, Layout, List, Radio, Row, Select, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, createScan, discoverModels, getEvaluators, getProviders, getScan, listScans, logout, type Connection } from '../../api'
import type { Evaluator, Model, Provider, Scan } from '../../types'
import Results, { statusLabel } from './Results'

const { Content, Footer, Header } = Layout
const { Text, Title } = Typography

export default function Workbench({ token, onExpired, onLogout }: { token: string; onExpired: () => void; onLogout: () => void }) {
  const [connection, setConnection] = useState<Connection>({ vendor: '', base_url: '', api_key: '' })
  const [providers, setProviders] = useState<Provider[]>([])
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [engineID, setEngineID] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [discovered, setDiscovered] = useState(false)
  const [scope, setScope] = useState<'all' | 'selected'>('selected')
  const [modelText, setModelText] = useState('')
  const [scan, setScan] = useState<Scan | null>(null)
  const [history, setHistory] = useState<Scan[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [revision, setRevision] = useState(0)
  const [reload, setReload] = useState(0)
  const selected = [...new Set(modelText.split(/[\s,，]+/).filter(Boolean))]
  const active = scan?.status === 'pending' || scan?.status === 'running'
  const scanID = scan?.id
  const locked = Boolean(busy) || active
  const ready = connection.vendor && connection.base_url.trim() && connection.api_key.trim()

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(); return }
    setError(err instanceof Error ? err.message : '请求失败')
  }, [onExpired])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([getProviders(token, controller.signal), getEvaluators(token, controller.signal), listScans(token, controller.signal)])
      .then(([p, e, h]) => {
        if (controller.signal.aborted) return
        setProviders(p.providers); setEngines(e.evaluators); setHistory(h.scans)
        setConnection((current) => ({ ...current, vendor: current.vendor || p.providers[0]?.id || '' }))
        setEngineID(e.evaluators[0]?.id || '')
        setScan(h.scans[0] || null)
        setError('')
      }).catch((err: unknown) => { if (!controller.signal.aborted) handleError(err) })
    return () => controller.abort()
  }, [token, handleError, reload])

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
        setHistory((current) => [item, ...current.filter((entry) => entry.id !== item.id)])
        if (item.status === 'pending' || item.status === 'running') timer = setTimeout(poll, 1200)
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) onExpired()
        else setPollError(err instanceof Error ? err.message : '无法读取进度')
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, scanID, token, onExpired, revision])

  function updateConnection(field: keyof Connection, value: string) {
    setConnection((current) => ({ ...current, [field]: value }))
    setModels([]); setDiscovered(false); setModelText(''); setError('')
  }
  async function discover() {
    setBusy('discover'); setError('')
    try { const result = await discoverModels(token, connection); setModels(result.models); setDiscovered(true) }
    catch (err) { handleError(err) }
    finally { setBusy('') }
  }
  async function start() {
    setBusy('start'); setError('')
    try {
      const item = await createScan(token, { ...connection, scope, models: scope === 'all' ? [] : selected, evaluator: engineID })
      setScan(item); setHistory((current) => [item, ...current]); setPollError('')
    } catch (err) { handleError(err) }
    finally { setBusy('') }
  }
  async function signOut() {
    setBusy('logout'); setError('')
    try { await logout(token); onLogout() } catch (err) { handleError(err) } finally { setBusy('') }
  }
  function toggle(id: string) { setModelText((selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]).join('\n')) }

  return (
    <Layout className="app-layout">
      <Header className="app-header">
        <Space className="brand" size={12}>
          <span className="brand-mark" aria-hidden="true">L</span>
          <Text strong>LLM Intelligence</Text>
          <Text type="secondary">/ 巡检工作台</Text>
        </Space>
        <Button type="text" icon={<LogoutOutlined />} onClick={() => void signOut()} loading={busy === 'logout'}>退出登录</Button>
      </Header>
      <Content className="app-content">
        <div className="page-heading">
          <Title level={1}>模型智力巡检</Title>
          <Text type="secondary">连接模型服务，执行可重复的能力检查。</Text>
        </div>
        {error && <Alert message={error} type="error" showIcon action={(!providers.length || !engines.length) && <Button type="link" icon={<ReloadOutlined />} onClick={() => setReload((n) => n + 1)}>重新加载</Button>} />}
        <Row gutter={[20, 20]} align="stretch" className="workspace-grid">
          <Col xs={24} lg={9}>
            <Card title={<Space><ApiOutlined />连接模型服务</Space>} extra={<Text type="secondary">OpenAI 兼容协议</Text>} className="workspace-card">
              <Form layout="vertical" requiredMark={false}>
                <Form.Item label="厂商 / 协议适配器">
                  <Select disabled={locked} value={connection.vendor || undefined} placeholder="正在加载…" onChange={(value) => updateConnection('vendor', value)} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
                </Form.Item>
                <Form.Item label="API Base URL">
                  <Input disabled={locked} type="url" value={connection.base_url} onChange={(event) => updateConnection('base_url', event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" />
                </Form.Item>
                <Form.Item label="模型 API Key">
                  <Input.Password disabled={locked} value={connection.api_key} onChange={(event) => updateConnection('api_key', event.target.value)} autoComplete="off" />
                </Form.Item>
                <Alert message="凭据只保留在当前页面与任务内存中，不会写入结果。" type="info" showIcon />
                <Button block icon={<SearchOutlined />} loading={busy === 'discover'} disabled={locked || !ready} onClick={() => void discover()}>
                  发现可用模型
                </Button>
              </Form>
            </Card>
          </Col>
          <Col xs={24} lg={15}>
            <Card title={<Space><ThunderboltOutlined />配置巡检范围</Space>} extra={discovered && <Badge color="#4359d7" text={`发现 ${models.length} 个模型`} />} className="workspace-card">
              <Form layout="vertical" requiredMark={false}>
                <Form.Item label="巡检范围">
                  <Radio.Group disabled={locked} value={scope} onChange={(event) => setScope(event.target.value)} optionType="button" buttonStyle="solid" options={[{ label: '指定模型', value: 'selected' }, { label: '全部模型', value: 'all' }]} />
                </Form.Item>
                {scope === 'selected' ? <>
                  <Form.Item label="模型 ID" extra="每行一个 ID，也可以使用逗号分隔；指定模型不依赖 /models 发现接口。">
                    <Input.TextArea disabled={locked} rows={3} value={modelText} onChange={(event) => setModelText(event.target.value)} placeholder="例如：gpt-4.1-mini\nclaude-3-7-sonnet" spellCheck={false} />
                  </Form.Item>
                </> : <Alert message="任务会重新发现并巡检接口返回的全部模型；不支持聊天协议的模型会单独标记为调用错误。" type="warning" showIcon />}
                {discovered && models.length === 0 && <Alert message="服务返回空列表，可以切换到“指定模型”手动输入 ID。" type="info" showIcon />}
                {models.length > 0 && scope === 'selected' && <div className="model-picker">
                  <Space className="model-picker-heading" align="center">
                    <Text type="secondary">从发现结果中选择</Text>
                    <Button type="link" size="small" onClick={() => setModelText(models.map((m) => m.id).join('\n'))}>全选列表</Button>
                  </Space>
                  <List size="small" bordered dataSource={models} renderItem={(model) => <List.Item><Checkbox disabled={locked} checked={selected.includes(model.id)} onChange={() => toggle(model.id)}>{model.id}</Checkbox></List.Item>} />
                </div>}
                <Form.Item label="检测引擎" extra={engines.find((engine) => engine.id === engineID)?.description}>
                  <Select disabled={locked} value={engineID || undefined} placeholder="正在加载…" onChange={setEngineID} options={engines.map((engine) => ({ value: engine.id, label: `${engine.name} · v${engine.version}` }))} />
                </Form.Item>
                <Button type="primary" block icon={<PlayCircleOutlined />} loading={busy === 'start'} disabled={locked || !ready || !engineID || (scope === 'selected' && selected.length === 0)} onClick={() => void start()}>
                  {active ? '巡检进行中…' : scope === 'all' ? '开始巡检全部模型' : `开始巡检${selected.length ? ` · ${selected.length} 个模型` : ''}`}
                </Button>
              </Form>
            </Card>
          </Col>
        </Row>
        {history.length > 0 && <Card size="small" className="history-card" title="本次服务运行中的任务">
          <Select style={{ width: '100%' }} value={scan?.id || undefined} disabled={active} onChange={(value) => { setScan(history.find((item) => item.id === value) || null); setPollError('') }} options={history.map((item) => ({ value: item.id, label: `${new Date(item.created_at).toLocaleString('zh-CN')} · ${item.id} · ${statusLabel(item.status)}` }))} />
        </Card>}
        {pollError && <Alert message={`进度读取已暂停：${pollError}`} type="error" showIcon action={<Button type="link" onClick={() => setRevision((n) => n + 1)}>重试读取</Button>} />}
        <Results scan={scan} />
      </Content>
      <Footer className="app-footer">任务与结果使用内存存储，服务重启后清空。基础巡检用于接入验证与能力回归。</Footer>
    </Layout>
  )
}
