import type { APIClient } from '../../api'
import { ApiOutlined, DeleteOutlined, EditOutlined, ImportOutlined, PlusOutlined, SaveOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Drawer, Empty, Flex, Form, Input, Popconfirm, Radio, Select, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd'
import { useEffect, useState } from 'react'
import { ApiError, discoverModels, readModelServices, saveModelServices } from '../../api'
import type { Model } from '../../types'
import { parseImportedServices, parseModelAPI, type ModelAPIConfig, type SavedModelService } from './savedServices'

const { Text, Paragraph } = Typography
export const protocolLabels = { chat_completions: 'Chat Completions', responses: 'Responses', messages: 'Messages' }
const importExample = JSON.stringify([
  { name: '研发 API', protocol: 'chat_completions', base_url: 'https://api.example.com/v1', api_key: '替换为你的 API Key', scope: 'selected', models: ['model-a', 'model-b'] },
  { name: '备用 API', protocol: 'messages', base_url: 'https://api.example.org/v1', api_key: '替换为你的 API Key', scope: 'all', models: [] },
], null, 2)

type Props = {
  token: APIClient
  defaultVendor: string
  locked: boolean
  onExpired: () => void
  onSelect: (service: SavedModelService | undefined) => void
}

const serviceKey = (service?: SavedModelService) => service ? `${service.source}:${service.id}` : ''

export default function ModelAPIs({ token, defaultVendor, locked, onExpired, onSelect }: Props) {
  const [services, setServices] = useState<SavedModelService[]>([])
  const [selectedID, setSelectedID] = useState('')
  const [storageReady, setStorageReady] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<{ id?: string; source?: SavedModelService['source'] } | null>(null)
  const [form] = Form.useForm<ModelAPIConfig>()
  const scope = Form.useWatch('scope', form)
  const [editorError, setEditorError] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [discovered, setDiscovered] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<ModelAPIConfig[]>([])
  const [importError, setImportError] = useState('')
  const disabled = locked || !storageReady || !defaultVendor

  useEffect(() => {
    let mounted = true
    readModelServices(token).then((items) => {
      if (!mounted) return
      setServices(items)
      setStorageReady(true)
      const first = items[0]
      setSelectedID(serviceKey(first))
      onSelect(first)
    }).catch((err: unknown) => { if (mounted) setStorageError(err instanceof Error ? err.message : '无法读取模型 API 配置') })
    return () => { mounted = false }
  }, [onSelect, token])

  async function persist(next: SavedModelService[], selection: string, success: string) {
    let saved: SavedModelService[]
    try { saved = await saveModelServices(token, next) }
    catch (err) { setStorageError(err instanceof Error ? err.message : '配置保存失败'); return false }
    const selected = saved.find((item) => serviceKey(item) === selection)
    setServices(saved)
    setSelectedID(serviceKey(selected))
    onSelect(selected)
    setStorageError('')
    setNotice(success)
    return true
  }

  function edit(service?: SavedModelService) {
    setEditorError(''); setNotice(''); setModels([]); setDiscovered(false)
    form.resetFields()
    form.setFieldsValue(service ? { ...service } : { name: '', protocol: 'chat_completions', base_url: '', api_key: '', scope: 'selected', models: [] })
    setEditor(service ? { id: service.id, source: service.source } : {})
  }

  async function save(values: ModelAPIConfig) {
    const previous = services.find((item) => item.id === editor?.id && item.source === editor?.source)
    let config: ModelAPIConfig
    try { config = parseModelAPI(values, false, previous?.source === 'cloud' && Boolean(previous.has_key)) }
    catch (err) { setEditorError(err instanceof Error ? err.message : '配置无效'); return }
    const source = previous?.source || (token.mode === 'cloud' ? 'cloud' : 'local')
    const item: SavedModelService = {
      ...config,
      id: previous?.id || crypto.randomUUID(),
      source,
      vendor: previous?.vendor || defaultVendor,
      service_name: config.name,
      updated_at: new Date().toISOString(),
      has_key: source === 'cloud' ? previous?.has_key || Boolean(config.api_key) : Boolean(config.api_key),
    }
    const next = previous ? services.map((service) => serviceKey(service) === serviceKey(previous) ? item : service) : [...services, item]
    if (await persist(next, serviceKey(item), source === 'local' ? '模型 API 已保存在浏览器本地。' : '模型 API 已保存到云端账号。')) { setEditor(null); form.resetFields() }
  }

  async function discover() {
    try { await form.validateFields(['protocol', 'base_url', 'api_key']) } catch { return }
    const values = form.getFieldsValue()
    const previous = services.find((item) => item.id === editor?.id && item.source === editor?.source)
    let config: ModelAPIConfig
    try { config = parseModelAPI({ ...values, name: values.name || '模型发现', scope: 'all', models: [], api_key: values.api_key || '' }, false, previous?.source === 'cloud' && Boolean(previous.has_key)) }
    catch (err) { setEditorError(err instanceof Error ? err.message : '请检查连接配置'); return }
    setDiscovering(true); setEditorError('')
    try {
      const response = await discoverModels(token, { service_id: previous?.source === 'cloud' ? previous.id : undefined, vendor: previous?.vendor || defaultVendor, service_name: config.name, protocol: config.protocol, base_url: config.base_url, api_key: config.api_key })
      setModels(response.models); setDiscovered(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired()
      else setEditorError(err instanceof Error ? err.message : '模型发现失败')
    } finally { setDiscovering(false) }
  }

  function updateImport(text: string) { setImportText(text); setPreview([]); setImportError('') }
  function checkImport() {
    try { setPreview(parseImportedServices(importText)); setImportError('') }
    catch (err) { setPreview([]); setImportError(err instanceof Error ? err.message : '无法读取配置') }
  }
  async function importServices() {
    const source = token.mode === 'cloud' ? 'cloud' : 'local'
    const added = preview.map((config): SavedModelService => ({
      ...config, id: crypto.randomUUID(), source, vendor: defaultVendor, service_name: config.name, updated_at: new Date().toISOString(), has_key: source === 'cloud',
    }))
    if (await persist([...services, ...added], serviceKey(added[0]), `已追加 ${added.length} 个模型 API。`)) {
      setImportOpen(false); updateImport('')
    }
  }

  return <>
    <Card className="model-api-panel" title={<Space><ApiOutlined />模型 API<Tag>{services.length} 项</Tag></Space>} extra={<Space wrap>
      <Button icon={<ImportOutlined />} disabled={disabled} onClick={() => { setNotice(''); updateImport(''); setImportOpen(true) }}>批量导入</Button>
      <Button type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={() => edit()}>添加 API</Button>
    </Space>}>
      <Alert type="info" showIcon title={token.mode === 'local' ? '本地模式：模型 API 只保存在当前浏览器' : '云端模式：已登录配置与本地配置合并展示'} description={token.mode === 'cloud' ? '每条配置带有本地或云端来源标记；云端 API Key 只在服务器保存，不会回传浏览器。' : '本地 API Key 只保存在当前浏览器，切换设备不会同步。'} />
      {storageError && <Alert type="error" showIcon title={storageError} />}
      {notice && <Alert type="success" showIcon title={notice} closable onClose={() => setNotice('')} />}
      <Table<SavedModelService> size="middle" rowKey={(service) => serviceKey(service)} dataSource={services} scroll={{ x: 1050 }} pagination={services.length > 10 ? { pageSize: 10, hideOnSinglePage: true } : false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="添加模型 API，或批量导入配置后开始巡检。" /> }}
        rowSelection={{ type: 'radio', selectedRowKeys: selectedID ? [selectedID] : [], getCheckboxProps: (service) => ({ disabled: locked, 'aria-label': `选择 ${service.name}` }), onChange: (keys) => {
          const key = String(keys[0]); const selected = services.find((service) => serviceKey(service) === key); setSelectedID(key); onSelect(selected)
        } }}
        columns={[
          { title: '模型 API 名称', dataIndex: 'name', width: 175, render: (name: string) => <Text strong>{name}</Text> },
          { title: '来源', dataIndex: 'source', width: 82, render: (source: SavedModelService['source']) => <Tag color={source === 'cloud' ? 'blue' : 'default'}>{source === 'cloud' ? '云端' : '本地'}</Tag> },
          { title: '请求协议', dataIndex: 'protocol', width: 160, render: (protocol: SavedModelService['protocol']) => <Tag>{protocolLabels[protocol]}</Tag> },
          { title: 'API Base URL', dataIndex: 'base_url', width: 245, render: (url: string) => <Text className="model-api-url">{url}</Text> },
          { title: 'API Key', key: 'key', width: 90, render: (_, service) => service.source === 'cloud' && !service.has_key ? <Tag color="warning">未配置</Tag> : <Text type="secondary" aria-label="API Key 已保存，内容隐藏">••••••••</Text> },
          { title: '巡检模型', key: 'scope', width: 190, render: (_, service) => service.scope === 'all' ? <Tag color="blue">全部模型</Tag> : service.models.length ? <Space orientation="vertical" size={2}>
            <Text>指定 {service.models.length} 个模型</Text><Tooltip title={service.models.join('、')}><Text type="secondary" className="model-api-models">{service.models.slice(0, 2).join('、')}{service.models.length > 2 ? ' …' : ''}</Text></Tooltip>
          </Space> : <Tag color="warning">请先指定模型</Tag> },
          { title: '操作', key: 'actions', width: 150, render: (_, service) => <Space size={0}>
            <Button type="link" icon={<EditOutlined />} disabled={disabled} onClick={() => edit(service)}>编辑</Button>
            <Popconfirm title={`删除“${service.name}”的配置？`} description={service.source === 'local' ? '仅删除当前浏览器中的配置，不会撤销 API Key。' : '仅删除当前云端账号的配置，不会撤销供应商 API Key。'} okText="删除" cancelText="取消" onConfirm={async () => {
              const next = services.filter((item) => serviceKey(item) !== serviceKey(service))
              await persist(next, selectedID === serviceKey(service) ? serviceKey(next[0]) : selectedID, '配置已删除。')
            }}><Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${service.name}`} disabled={disabled} /></Popconfirm>
          </Space> },
        ]} />
      {services.length > 0 && <Text type="secondary">选择一个模型 API，再在下方选择巡检引擎和执行位置。模型范围按各 API 独立保存。</Text>}
    </Card>

    <Drawer title={editor?.id ? '编辑模型 API' : '添加模型 API'} open={editor !== null} size={600} forceRender
      closable={!discovering} maskClosable={!discovering} keyboard={!discovering} onClose={() => { setEditor(null); form.resetFields() }}
      extra={<Button type="primary" icon={<SaveOutlined />} disabled={discovering || disabled} onClick={() => form.submit()}>{editor?.source === 'cloud' || (!editor?.source && token.mode === 'cloud') ? '保存到云端' : '保存到本机'}</Button>}>
      <Alert className="model-api-editor-note" type="info" showIcon title={editor?.source === 'cloud' || (!editor?.source && token.mode === 'cloud') ? '云端配置保存在当前账号，API Key 不回显' : '配置仅保存在当前浏览器本地'} />
      {editorError && <Alert className="model-api-editor-note" type="error" showIcon title={editorError} />}
      {storageError && <Alert className="model-api-editor-note" type="error" showIcon title={storageError} />}
      <Form<ModelAPIConfig> form={form} layout="vertical" disabled={discovering || locked} onFinish={save} onValuesChange={(changed) => {
        setEditorError('')
        if ('base_url' in changed || 'api_key' in changed || 'protocol' in changed) { setModels([]); setDiscovered(false) }
      }}>
        <Form.Item name="name" label="模型 API 名称" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}><Input placeholder="例如：研发网关" autoComplete="off" /></Form.Item>
        <Form.Item name="protocol" label="请求协议" rules={[{ required: true }]}><Select options={Object.entries(protocolLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item name="base_url" label="API Base URL" rules={[{ required: true, whitespace: true, message: '请输入 API Base URL' }]}><Input placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" /></Form.Item>
        <Form.Item name="api_key" label="API Key" rules={[{ required: !(editor?.source === 'cloud' && services.find((item) => item.id === editor?.id && item.source === editor?.source)?.has_key), whitespace: true, message: '请输入 API Key' }]}><Input.Password autoComplete="off" placeholder={editor?.source === 'cloud' ? '留空保留云端密钥' : 'API Key'} /></Form.Item>
        <Form.Item name="scope" label="巡检模型" rules={[{ required: true }]}><Radio.Group optionType="button" buttonStyle="solid" options={[{ label: '指定模型', value: 'selected' }, { label: '全部模型', value: 'all' }]} /></Form.Item>
        {scope === 'selected' ? <>
          <Form.Item name="models" label="模型 ID" extra="输入模型 ID 后按回车，可用逗号、空格或换行分隔；也可从发现结果中选择。" rules={[{ required: true, type: 'array', min: 1, message: '至少指定一个模型' }]}>
            <Select mode="tags" tokenSeparators={[',', '，', ' ', '\n']} placeholder="输入或选择模型 ID" options={models.map((model) => ({ value: model.id, label: model.id }))} />
          </Form.Item>
          <Space wrap><Button icon={<SearchOutlined />} loading={discovering} onClick={() => void discover()}>发现可用模型</Button>
            {discovered && <Text type="secondary">{models.length ? `发现 ${models.length} 个模型，可在上方选择` : '发现接口返回空列表，请手动填写模型 ID'}</Text>}
          </Space>
        </> : <Alert type="info" showIcon title="开始巡检时发现并检测全部模型" description="此 API 需要支持模型发现接口；每次巡检都会重新获取模型列表。" />}
      </Form>
    </Drawer>

    <Drawer title="批量导入模型 API" open={importOpen} size={700} onClose={() => { setImportOpen(false); updateImport('') }}
      extra={<Button type="primary" disabled={!preview.length || disabled} onClick={importServices}>{preview.length ? `导入 ${preview.length} 项` : '导入配置'}</Button>}>
      <Paragraph>导入 JSON 数组，每项包含名称、协议、Base URL、API Key 和巡检模型。导入会追加到当前{token.mode === 'local' ? '浏览器' : '云端账号'}，不会覆盖已有配置。</Paragraph>
      <Flex wrap gap={12} className="model-api-import-tools">
        <Upload accept=".json,application/json" showUploadList={false} beforeUpload={(file) => { void file.text().then(updateImport).catch(() => setImportError('无法读取文件，请检查文件后重试。')); return false }}><Button icon={<UploadOutlined />}>读取本地 JSON 文件</Button></Upload>
        <Button onClick={() => updateImport(importExample)}>填入格式示例</Button>
      </Flex>
      <Input.TextArea aria-label="模型 API 配置 JSON" value={importText} rows={13} onChange={(event) => updateImport(event.target.value)} placeholder={importExample} spellCheck={false} />
      <Space className="model-api-import-tools"><Button disabled={!importText.trim()} onClick={checkImport}>检查配置</Button><Text type="secondary">{token.mode === 'local' ? '文件在浏览器内解析，不会上传云端。' : '确认导入后配置将保存到云端账号。'}</Text></Space>
      {importError && <Alert type="error" showIcon title={importError} />}
      {storageError && <Alert type="error" showIcon title={storageError} />}
      {preview.length > 0 && <>
        <Alert type="success" showIcon title={`已识别 ${preview.length} 项配置，请确认后导入。`} />
        <Table size="small" pagination={false} rowKey="index" dataSource={preview.map((item, index) => ({ ...item, index }))} columns={[
          { title: '名称', dataIndex: 'name' }, { title: 'API Base URL', dataIndex: 'base_url', render: (url: string) => <Text className="model-api-url">{url}</Text> }, { title: '请求协议', dataIndex: 'protocol', render: (protocol: ModelAPIConfig['protocol']) => protocolLabels[protocol] },
          { title: '巡检模型', key: 'models', render: (_, item) => item.scope === 'all' ? '全部模型' : `指定 ${item.models.length} 个模型` },
        ]} />
      </>}
    </Drawer>
  </>
}
