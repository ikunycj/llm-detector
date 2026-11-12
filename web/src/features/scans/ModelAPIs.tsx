import { DeleteOutlined, EditOutlined, ImportOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Drawer, Empty, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { readModelServices, saveModelServices } from '../../api'
import { SourceTag, useLocations, useSourceData } from '../../app/Locations'
import { recordKey, sourceID, type SourceID } from '../../data/sources'
import { parseImportedServices, type SavedModelService } from './savedServices'
import ModelAPIEditor, { protocolLabels } from './ModelAPIEditor'
export { protocolLabels } from './ModelAPIEditor'
const load = readModelServices
export default function ModelAPIs({
  canInspect,
  onInspect,
}: {
  canInspect: boolean
  onInspect: (service: SavedModelService) => void
}) {
  const { items, errors, loading, setItems } = useSourceData(load)
  const { choose, owner, changed, clients, label } = useLocations()
  const [name, setName] = useState('')
  const [url, setURL] = useState('')
  const [protocol, setProtocol] = useState<SavedModelService['protocol']>()
  const [source, setSource] = useState<SourceID | 'worker'>()
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10 })
  const [editor, setEditor] = useState<{ service?: SavedModelService }>()
  const [importing, setImporting] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const filtered = items.filter((item) =>
    item.name.toLocaleLowerCase().includes(name.trim().toLocaleLowerCase()) &&
    item.base_url.toLocaleLowerCase().includes(url.trim().toLocaleLowerCase()) &&
    (!protocol || item.protocol === protocol) &&
    (!source || (source === 'worker' ? item.source.startsWith('worker:') : item.source === source)),
  )
  const current = Math.min(pagination.current, Math.max(1, Math.ceil(filtered.length / pagination.pageSize)))
  const hasFilters = Boolean(name || url || protocol || source)
  function firstPage() {
    setPagination((value) => ({ ...value, current: 1 }))
  }
  function clearFilters() {
    setName('')
    setURL('')
    setProtocol(undefined)
    setSource(undefined)
    firstPage()
  }
  async function importItems() {
    setError('')
    try {
      const configs = parseImportedServices(text)
      const client = await choose({ action: 'save', title: `导入的 ${configs.length} 个模型 API 保存到哪里？` })
      if (!client) return
      const current = await readModelServices(client)
      const added = configs.map((config): SavedModelService => ({
        ...config,
        id: crypto.randomUUID(),
        source: sourceID(client),
        vendor: 'openai-compatible',
        service_name: config.name,
        updated_at: new Date().toISOString(),
      }))
      await saveModelServices(client, [...current, ...added])
      changed()
      setImporting(false)
      setText('')
      clearFilters()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    }
  }
  return (
    <>
      <Card
        title="模型 API"
        className="model-api-panel"
        loading={loading}
        extra={
          <Space>
            <Button icon={<ImportOutlined />} onClick={() => setImporting(true)}>
              批量导入
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({})}>
              添加 API
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          title="所有位置的模型 API 统一展示"
          description="来源标明存储位置。本地配置只保存在当前浏览器；保存与执行时分别选择位置。"
        />
        {errors.map((message) => (
          <Alert key={message} type="warning" showIcon title={message} />
        ))}
        {error && <Alert type="error" title={error} />}
        <Form layout="vertical" className="model-api-filters" aria-label="筛选模型 API">
          <Form.Item label="名称">
            <Input
              aria-label="搜索模型 API 名称"
              allowClear
              placeholder="按名称模糊搜索"
              value={name}
              onChange={(event) => { setName(event.target.value); firstPage() }}
            />
          </Form.Item>
          <Form.Item label="URL">
            <Input
              aria-label="搜索模型 API URL"
              allowClear
              placeholder="按 URL 模糊搜索"
              value={url}
              onChange={(event) => { setURL(event.target.value); firstPage() }}
            />
          </Form.Item>
          <Form.Item label="协议">
            <Select
              aria-label="筛选请求协议"
              allowClear
              placeholder="全部协议"
              value={protocol}
              onChange={(value) => { setProtocol(value); firstPage() }}
              options={Object.entries(protocolLabels).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item label="来源">
            <Select
              aria-label="筛选数据来源"
              allowClear
              placeholder="全部来源"
              value={source}
              onChange={(value) => { setSource(value); firstPage() }}
              options={[
                { value: 'local', label: '浏览器本地' },
                { value: 'cloud', label: '云端' },
                { value: 'worker', label: '全部自建 Worker' },
                ...clients.filter((client) => client.mode === 'worker').map((client) => ({
                  value: sourceID(client), label: label(sourceID(client)),
                })),
              ]}
            />
          </Form.Item>
          <Button onClick={clearFilters} disabled={!hasFilters}>重置筛选</Button>
        </Form>
        <Table<SavedModelService>
          rowKey={recordKey}
          dataSource={filtered}
          size="middle"
          scroll={{ x: 1180 }}
          pagination={{
            current,
            pageSize: pagination.pageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total) => hasFilters ? `匹配 ${total} 条，共 ${items.length} 条` : `共 ${total} 条`,
            onChange: (page, pageSize) => setPagination({
              current: pageSize === pagination.pageSize ? page : 1,
              pageSize,
            }),
          }}
          locale={{ emptyText: (
            <Empty
              description={hasFilters ? '没有匹配的模型 API，请调整筛选条件' : '添加模型 API 后开始巡检'}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              {hasFilters && <Button onClick={clearFilters}>清空筛选</Button>}
            </Empty>
          ) }}
          columns={[
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '来源', dataIndex: 'source', render: (source) => <SourceTag source={source} /> },
            {
              title: '协议',
              dataIndex: 'protocol',
              render: (value: SavedModelService['protocol']) => <Tag>{protocolLabels[value]}</Tag>,
            },
            { title: 'API Base URL', dataIndex: 'base_url', width: 240, ellipsis: true },
            { title: 'API Key', width: 100, render: () => '••••••••' },
            { title: '巡检模型', ellipsis: true, render: (_, item) => (item.scope === 'all' ? '全部模型' : item.models.join('、')) },
            {
              title: '操作',
              fixed: 'right',
              width: 230,
              render: (_, item) => (
                <Space size={0}>
                  <Button
                    type="link"
                    icon={<PlayCircleOutlined />}
                    disabled={!canInspect}
                    onClick={() => onInspect(item)}
                  >
                    巡检
                  </Button>
                  <Button
                    type="link"
                    icon={<EditOutlined />}
                    onClick={() => setEditor({ service: item })}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除此位置的配置？"
                    onConfirm={async () => {
                      try {
                        const client = owner(item.source)
                        const current = await readModelServices(client)
                        await saveModelServices(
                          client,
                          current.filter((row) => row.id !== item.id),
                        )
                        changed()
                      } catch (err) {
                        setError(err instanceof Error ? err.message : '删除失败')
                      }
                    }}
                  >
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除 ${item.name}`}
                    />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <ModelAPIEditor
        open={Boolean(editor)}
        service={editor?.service}
        onClose={() => setEditor(undefined)}
        onSaved={(item) => {
          setItems((current) => [...current.filter((row) => recordKey(row) !== recordKey(item)), item])
          clearFilters()
        }}
      />
      <Drawer
        title="批量导入模型 API"
        open={importing}
        onClose={() => setImporting(false)}
        size={640}
        extra={
          <Button type="primary" onClick={() => void importItems()}>
            保存
          </Button>
        }
      >
        <Typography.Paragraph>粘贴 JSON 数组。确认后选择保存位置，追加配置。</Typography.Paragraph>
        <Input.TextArea
          rows={16}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            '[{"name":"我的 API","protocol":"responses","base_url":"https://api.example.com/v1","api_key":"...","scope":"selected","models":["model-id"]}]'
          }
        />
        {error && <Alert type="error" title={error} />}
      </Drawer>
    </>
  )
}
