import { Alert, Button, Drawer, Form, Input, Radio, Select, Space } from 'antd'
import { useEffect, useState } from 'react'
import { connectionFor, discoverModels, readModelServices, saveModelServices, transferModelService } from '../../api'
import { useLocations } from '../../app/Locations'
import { sourceID } from '../../data/sources'
import { parseModelAPI, type ModelAPIConfig, type SavedModelService } from './savedServices'
export const protocolLabels = { chat_completions: 'Chat Completions', responses: 'Responses', messages: 'Messages' }
export default function ModelAPIEditor({
  open,
  service,
  onClose,
  onSaved,
}: {
  open: boolean
  service?: SavedModelService
  onClose: () => void
  onSaved?: (item: SavedModelService) => void
}) {
  const [form] = Form.useForm<ModelAPIConfig>()
  const scope = Form.useWatch('scope', form)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const { choose, owner, changed } = useLocations()
  useEffect(() => {
    if (open) {
      form.resetFields()
      form.setFieldsValue(
        service || { name: '', protocol: 'chat_completions', base_url: '', api_key: '', scope: 'selected', models: [] },
      )
      setError('')
      setModels(service?.models || [])
    }
  }, [open, service, form])
  async function save(values: ModelAPIConfig) {
    setError('')
    try {
      const config = parseModelAPI(values, false, Boolean(service?.has_key))
      const destination = await choose({ action: 'save', title: '模型 API 保存到哪里？', from: service?.source })
      if (!destination) return
      setBusy(true)
      const same = Boolean(service && service.source === sourceID(destination))
      const credentials =
        service && !same && !config.api_key ? await transferModelService(owner(service.source), service) : undefined
      const item: SavedModelService = {
        ...config,
        api_key: config.api_key || credentials?.api_key || '',
        id: same ? service!.id : crypto.randomUUID(),
        vendor: service?.vendor || 'openai-compatible',
        service_name: config.name,
        source: sourceID(destination),
        updated_at: new Date().toISOString(),
        has_key: Boolean(config.api_key || service?.has_key),
      }
      const current = await readModelServices(destination)
      const saved = await saveModelServices(destination, [...current.filter((row) => row.id !== item.id), item])
      changed()
      onSaved?.(saved.find((row) => row.id === item.id)!)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }
  async function discover() {
    setError('')
    try {
      const values = form.getFieldsValue()
      const config = parseModelAPI(
        { ...values, name: values.name || '模型发现', scope: 'all', models: [] },
        false,
        Boolean(service?.has_key),
      )
      const destination = await choose({ action: 'execute', title: '在哪里发现模型？', from: service?.source })
      if (!destination) return
      setBusy(true)
      const input =
        service && !config.api_key
          ? await connectionFor(service, owner(service.source), destination)
          : { ...config, vendor: 'openai-compatible', service_name: config.name }
      const result = await discoverModels(destination, input)
      setModels(result.models.map((item) => item.id))
      if (!result.models.length) setError('接口返回空模型列表，请手动填写模型 ID')
    } catch (err) {
      setError(err instanceof Error ? err.message : '模型发现失败；浏览器直连需要供应商允许跨域')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      title={service ? '编辑模型 API' : '新增模型 API'}
      open={open}
      onClose={onClose}
      size={600}
      destroyOnHidden
      extra={
        <Button type="primary" onClick={() => form.submit()} loading={busy}>
          保存
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        title="保存时选择浏览器本地、云端或自建 Worker"
        description="保存到其他位置会创建副本；本地配置只保存在当前浏览器。"
      />
      {error && <Alert type="error" showIcon title={error} />}
      <Form name="model-api-editor" form={form} layout="vertical" onFinish={save} disabled={busy}>
        <Form.Item name="name" label="模型 API 名称" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="protocol" label="请求协议" rules={[{ required: true }]}>
          <Select options={Object.entries(protocolLabels).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Form.Item name="base_url" label="API Base URL" rules={[{ required: true }]}>
          <Input placeholder="https://api.example.com/v1" />
        </Form.Item>
        <Form.Item name="api_key" label="API Key" rules={[{ required: !service?.has_key }]}>
          <Input.Password autoComplete="off" placeholder={service?.has_key ? '留空保留原密钥' : 'API Key'} />
        </Form.Item>
        <Form.Item name="scope" label="巡检模型">
          <Radio.Group
            options={[
              { value: 'selected', label: '指定模型' },
              { value: 'all', label: '全部模型' },
            ]}
          />
        </Form.Item>
        {scope === 'selected' && (
          <Form.Item name="models" label="模型 ID" rules={[{ required: true, type: 'array', min: 1 }]}>
            <Select
              mode="tags"
              tokenSeparators={[',', '，', ' ', '\n']}
              options={models.map((value) => ({ value, label: value }))}
            />
          </Form.Item>
        )}
        <Space>
          <Button onClick={() => void discover()} loading={busy}>
            发现模型
          </Button>
        </Space>
      </Form>
    </Drawer>
  )
}
