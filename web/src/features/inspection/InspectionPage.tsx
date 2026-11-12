import {
  ApiOutlined,
  CalendarOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  KeyOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import { useMemo, useState, useEffect } from 'react'
import {
  copyProject,
  deleteInspectionProject,
  getCatalog,
  getInspectionProjects,
  getInspectionRuns,
  importInspectionKeys,
  runInspectionProject,
  saveInspectionChannelProtocol,
  saveInspectionPlan,
  saveInspectionProject,
  syncInspectionProject,
  exportProject,
  type APIClient,
} from '../../api'
import { SourceTag, useLocations, useSourceData } from '../../app/Locations'
import { recordKey, sourceID } from '../../data/sources'
import type { Evaluator } from '../../types'
import type { LogNavigation } from '../logs/records'
import type { BatchRun, InspectionPlan, InspectionProject, ProjectChannel, ProjectInput } from './types'
const { Text, Title } = Typography
const statuses: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  completed: '已完成',
  completed_with_errors: '完成 · 存在错误',
  failed: '失败',
  interrupted: '已中断',
  error: '无法执行',
}
const protocols: Record<string, string> = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
  messages: 'Messages',
}
const date = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '—')
const load = async (client: APIClient, signal: AbortSignal) => {
  const [p, r] = await Promise.all([getInspectionProjects(client, signal), getInspectionRuns(client, signal)])
  return [{ projects: p.projects, runs: r.runs }]
}
export default function InspectionPage({ onOpenLogs }: LogNavigation) {
  const { owner, choose, ensure, changed, label } = useLocations()
  const { items, errors, loading, refresh } = useSourceData(load, 5000)
  const projects = items.flatMap((item) => item.projects),
    runs = items.flatMap((item) => item.runs).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const [selected, setSelected] = useState<string>()
  const project = projects.find((item) => recordKey(item) === selected) || projects[0]
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ project?: InspectionProject }>()
  const [settings, setSettings] = useState<InspectionProject>()
  const [syncProject, setSyncProject] = useState<InspectionProject>()
  const [keyProject, setKeyProject] = useState<InspectionProject>()
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])
  const [group, setGroup] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [batchProjects, setBatchProjects] = useState<string[]>([])
  const [report, setReport] = useState<{ project: InspectionProject; channel: ProjectChannel }>()
  const [connectionForm] = Form.useForm<ProjectInput>()
  const [planForm] = Form.useForm<InspectionPlan>()
  const [syncForm] = Form.useForm<{ import_keys: boolean; two_factor_code: string }>()
  const [keyForm] = Form.useForm<{ code: string }>()
  const [identity, setIdentity] = useState<'account' | 'id'>('account')
  const planMode = Form.useWatch('mode', planForm)
  const planEngines = Form.useWatch('evaluators', planForm) || []
  useEffect(() => {
    const controller = new AbortController()
    getCatalog(controller.signal)
      .then((data) => setEngines(data.evaluators))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message)
      })
    return () => controller.abort()
  }, [])
  const histories = useMemo(() => {
    const map = new Map<string, Array<{ run: BatchRun; item: BatchRun['items'][number] }>>()
    for (const run of runs)
      for (const item of run.items) {
        const key = `${run.source}:${run.project_id}:${item.channel_id}`
        const list = map.get(key) || []
        list.push({ run, item })
        map.set(key, list)
      }
    return map
  }, [items])
  const history = report
    ? histories.get(`${report.project.source}:${report.project.id}:${report.channel.id}`) || []
    : []
  async function work(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
      changed()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  async function destination(p: InspectionProject, action: 'save' | 'execute', title: string, runner = false) {
    const client = await choose({ action, title, from: p.source, requireRunner: runner })
    if (!client) return null
    const copied = await copyProject(owner(p.source), p, client)
    setSelected(recordKey({ ...copied, source: sourceID(client) }))
    return { client, project: copied }
  }
  function openConnection(p?: InspectionProject) {
    connectionForm.resetFields()
    connectionForm.setFieldsValue({
      name: p?.name || '',
      kind: 'newapi',
      base_url: p?.base_url || '',
      admin_account: p?.admin_account || '',
      user_id: p?.user_id || 1,
      access_token: '',
      password: '',
      login_code: '',
    })
    setIdentity(p && !p.admin_account ? 'id' : 'account')
    setEditor({ project: p })
  }
  async function saveConnection(values: ProjectInput) {
    await work(async () => {
      const target = await choose({ action: 'save', title: '项目连接保存到哪里？', from: editor?.project?.source })
      if (!target) return
      const previous = editor?.project
      const same = previous && previous.source === sourceID(target)
      let input = {
        ...values,
        user_id: identity === 'id' ? values.user_id : previous?.user_id || 0,
        admin_account: identity === 'account' ? values.admin_account : '',
        password: identity === 'account' ? values.password : '',
        login_code: identity === 'account' ? values.login_code : '',
      }
      if (previous && !same && !input.access_token) {
        const data = await exportProject(owner(previous.source), previous)
        input = { ...input, access_token: data.access_token }
      }
      const needRunner = target.mode === 'local' && identity === 'account' && (!previous || Boolean(input.password) || input.admin_account !== previous.admin_account)
      const client = await ensure(target, needRunner)
      if (!client) return
      const copied = previous && !same ? await copyProject(owner(previous.source), previous, client) : previous
      const saved = await saveInspectionProject(client, input, copied?.id)
      setSelected(recordKey({ ...saved, source: sourceID(client) }))
      setEditor(undefined)
    })
  }
  async function run(p: InspectionProject) {
    await work(async () => {
      const dest = await destination(p, 'execute', '项目巡检在哪里执行？', true)
      if (!dest) return
      const result = await runInspectionProject(dest.client, dest.project.id)
      onOpenLogs({ kind: 'batch', id: result.id, source: sourceID(dest.client) })
    })
  }
  async function batchRun() {
    await work(async () => {
      const client = await choose({ action: 'execute', title: '批量项目巡检在哪里执行？', requireRunner: true })
      if (!client) return
      const failures: string[] = []
      for (const key of batchProjects) {
        const p = projects.find((item) => recordKey(item) === key)
        if (!p) continue
        try {
          const copy = await copyProject(owner(p.source), p, client)
          await runInspectionProject(client, copy.id)
        } catch (err) {
          failures.push(`${p.name}：${err instanceof Error ? err.message : '启动失败'}`)
        }
      }
      if (failures.length) setError(failures.join('；'))
    })
  }
  function openSettings(p: InspectionProject) {
    planForm.resetFields()
    planForm.setFieldsValue(p.plan)
    setSettings(p)
  }
  async function savePlan(values: InspectionPlan) {
    if (!settings) return
    await work(async () => {
      const client = await choose({ action: 'save', title: '巡检设置保存到哪里？', from: settings.source })
      if (!client) return
      if (client.mode === 'local' && values.enabled)
        throw new Error('浏览器无法离线调度，请关闭定时或选择云端 / 自建 Worker')
      const copied = await copyProject(owner(settings.source), settings, client)
      await saveInspectionPlan(client, copied.id, values)
      setSelected(recordKey({ ...copied, source: sourceID(client) }))
      setSettings(undefined)
    })
  }
  async function changeProtocol(ch: ProjectChannel, protocol: string) {
    if (!project) return
    await work(async () => {
      const dest = await destination(project, 'save', '渠道测试协议保存到哪里？')
      if (!dest) return
      await saveInspectionChannelProtocol(dest.client, dest.project.id, ch.id, protocol)
    })
  }
  async function sync(values: { import_keys: boolean; two_factor_code: string }) {
    if (!syncProject) return
    await work(async () => {
      const dest = await destination(syncProject, 'execute', '在哪里同步并保存渠道？', true)
      if (!dest) return
      const result = await syncInspectionProject(dest.client, dest.project.id, values)
      if (result.last_error) setError(result.last_error)
      setSyncProject(undefined)
      syncForm.resetFields()
    })
  }
  async function importKeys(values: { code: string }) {
    if (!keyProject) return
    await work(async () => {
      const dest = await destination(keyProject, 'save', '渠道密钥保存到哪里？', true)
      if (!dest) return
      const result = await importInspectionKeys(dest.client, dest.project.id, selectedChannels, values.code)
      const failures = result.channels.filter((ch) => selectedChannels.includes(ch.id) && ch.key_error)
      if (failures.length) setError(failures.map((ch) => `${ch.name}：${ch.key_error}`).join('；'))
      setKeyProject(undefined)
      keyForm.resetFields()
    })
  }
  const visible =
    project?.channels.filter((ch) => (!group || ch.groups.includes(group)) && (!tag || ch.tag === tag)) || []
  function reportRows(p: InspectionProject, ch: ProjectChannel) {
    const rows = histories.get(`${p.source}:${p.id}:${ch.id}`) || []
    const latestID = rows[0]?.run.id
    const latest = rows.filter((row) => row.run.id === latestID)
    return (
      <Space orientation="vertical" size={0}>
        {!latest.length ? (
          <Text type="secondary">未检查</Text>
        ) : (
          latest.map(({ run, item }) => (
            <span key={item.evaluator}>
              <Tag
                color={item.status === 'completed' ? 'success' : item.status === 'running' ? 'processing' : 'warning'}
              >
                {engines.find((e) => e.id === item.evaluator)?.name || item.evaluator} ·{' '}
                {statuses[item.status] || item.status}
              </Tag>
              <Text type="secondary">{date(run.created_at)}</Text>
            </span>
          ))
        )}
        <Button size="small" type="link" onClick={() => setReport({ project: p, channel: ch })}>
          更多
        </Button>
      </Space>
    )
  }
  return (
    <Layout>
      <Layout className="inspection-layout">
        <Layout.Sider width={240} theme="light" className="inspection-sider">
          <Button block type="primary" icon={<PlusOutlined />} disabled={busy} onClick={() => openConnection()}>
            添加项目
          </Button>
          <Menu
            selectedKeys={project ? [recordKey(project)] : []}
            items={[
              ...projects.map((item) => ({
                key: recordKey(item),
                icon: <ApiOutlined />,
                label: (
                  <span>
                    {item.name}
                    <small style={{ display: 'block' }}>{label(item.source)}</small>
                  </span>
                ),
              })),
            ]}
            onClick={({ key }) => {
              setSelected(key)
              setSelectedChannels([])
              setGroup(undefined)
              setTag(undefined)
            }}
          />
        </Layout.Sider>
        <Layout.Content className="inspection-main">
          {errors.map((message) => (
            <Alert key={message} type="warning" title={message} action={<Button onClick={refresh}>重试</Button>} />
          ))}
          {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
          {projects.length > 1 && (
              <Flex gap={12} wrap className="inspection-batch-toolbar">
                <Select
                  mode="multiple"
                  aria-label="批量巡检项目"
                  value={batchProjects}
                  onChange={setBatchProjects}
                  style={{ minWidth: 300 }}
                  placeholder="选择项目"
                  options={projects.map((p) => ({
                    value: recordKey(p),
                    label: `${p.name} · ${label(p.source)}`,
                    disabled: p.busy,
                  }))}
                />
                <Button disabled={busy || !batchProjects.length} onClick={() => void batchRun()}>
                  批量立即巡检
                </Button>
              </Flex>
          )}
          {project ? (
            <Card
              title={
                <Space>
                  {project.name}
                  <SourceTag source={project.source} />
                </Space>
              }
            >
              <Space wrap className="inspection-project-actions">
                <Button icon={<LinkOutlined />} disabled={busy} onClick={() => openConnection(project)}>
                  连接
                </Button>
                <Button
                  icon={<SettingOutlined />}
                  disabled={busy || project.busy}
                  onClick={() => openSettings(project)}
                >
                  设置
                </Button>
                <Button
                  icon={<CloudSyncOutlined />}
                  disabled={busy || project.busy}
                  onClick={() => {
                    syncForm.resetFields()
                    syncForm.setFieldsValue({ import_keys: true, two_factor_code: '' })
                    setSyncProject(project)
                  }}
                >
                  立即同步
                </Button>
                <Popconfirm
                  title="删除该来源的项目连接？"
                  description="历史批次保留"
                  onConfirm={() =>
                    work(async () => {
                      await deleteInspectionProject(owner(project.source), project.id)
                      setSelected(undefined)
                    })
                  }
                >
                  <Button danger icon={<DeleteOutlined />} disabled={busy || project.busy}>
                    删除
                  </Button>
                </Popconfirm>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  disabled={busy || project.busy || !project.synced_at}
                  onClick={() => void run(project)}
                >
                  立即巡检
                </Button>
              </Space>
              <Descriptions
                className="inspection-project-meta"
                items={[
                  { key: 'base', label: '项目地址', children: project.base_url },
                  { key: 'synced', label: '同步时间', children: date(project.synced_at) },
                  {
                    key: 'next',
                    label: '下次巡检',
                    children: project.plan.enabled ? date(project.next_run_at) : '未启用',
                  },
                ]}
              />
              {project.last_error && <Alert type="error" title={project.last_error} />}
              <Flex gap={12} wrap className="inspection-toolbar">
                <Select
                  allowClear
                  placeholder="全部分组"
                  value={group}
                  onChange={setGroup}
                  style={{ width: 180 }}
                  options={project.groups.map((value) => ({ value, label: value }))}
                />
                <Select
                  allowClear
                  placeholder="全部标签"
                  value={tag}
                  onChange={setTag}
                  style={{ width: 180 }}
                  options={[...new Set(project.channels.map((ch) => ch.tag).filter(Boolean))].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
                <Button
                  icon={<KeyOutlined />}
                  disabled={!selectedChannels.length || busy}
                  onClick={() => setKeyProject(project)}
                >
                  导入选中渠道密钥
                </Button>
              </Flex>
              <Table<ProjectChannel>
                rowKey="id"
                dataSource={visible}
                size="small"
                scroll={{ x: 1560 }}
                pagination={{ pageSize: 10, showSizeChanger: true }}
                rowSelection={{
                  selectedRowKeys: selectedChannels,
                  onChange: (keys) => setSelectedChannels(keys.map(String)),
                  getCheckboxProps: (ch) => ({ disabled: !ch.enabled || Boolean(ch.issue) || busy }),
                }}
                columns={[
                  {
                    title: '渠道',
                    width: 220,
                    render: (_, ch) => (
                      <Space orientation="vertical" size={0}>
                        <Text strong>
                          {ch.name} · #{ch.id}
                        </Text>
                        <Text type="secondary">{ch.base_url}</Text>
                        <SourceTag source={project.source} />
                      </Space>
                    ),
                  },
                  { title: '分组', dataIndex: 'groups', width: 170, render: (values: string[]) => values.join('、') },
                  { title: '标签', dataIndex: 'tag', width: 170 },
                  {
                    title: '测试协议',
                    width: 190,
                    render: (_, ch) => (
                      <Select
                        style={{ width: '100%' }}
                        aria-label={`渠道 ${ch.id} 的测试协议`}
                        disabled={busy || project.busy}
                        value={ch.protocol_override || ''}
                        onChange={(value) => void changeProtocol(ch, value)}
                        options={[
                          { value: '', label: `跟随渠道：${protocols[ch.protocol] || ch.protocol}` },
                          ...Object.entries(protocols).map(([value, label]) => ({ value, label })),
                        ]}
                      />
                    ),
                  },
                  {
                    title: '状态',
                    width: 140,
                    render: (_, ch) => (
                      <Space orientation="vertical">
                        <Tag color={ch.enabled ? 'success' : 'default'}>{ch.enabled ? '启用' : '停用'}</Tag>
                        {ch.issue && <Text type="danger">{ch.issue}</Text>}
                      </Space>
                    ),
                  },
                  {
                    title: '密钥',
                    width: 150,
                    render: (_, ch) => (
                      <Space orientation="vertical">
                        <Tag color={ch.has_key ? 'success' : 'warning'}>{ch.has_key ? '已保存' : '未导入'}</Tag>
                        {ch.key_error && <Text type="danger">{ch.key_error}</Text>}
                      </Space>
                    ),
                  },
                  {
                    title: '模型',
                    width: 230,
                    render: (_, ch) => <Text ellipsis={{ tooltip: ch.models.join('、') }}>{ch.models.join('、')}</Text>,
                  },
                  { title: '测试报告', width: 280, render: (_, ch) => reportRows(project, ch) },
                ]}
              />
            </Card>
          ) : (
            <Card loading={loading}><Empty description="还没有项目，点击左侧“添加项目”开始配置。" /></Card>
          )}
        </Layout.Content>
      </Layout>
      <Drawer
        title={editor?.project ? '编辑项目连接' : '添加 New API 项目'}
        open={Boolean(editor)}
        onClose={() => setEditor(undefined)}
        size={600}
        extra={
          <Button type="primary" onClick={() => connectionForm.submit()} loading={busy}>
            保存
          </Button>
        }
      >
        <Form
          name="project-connection"
          form={connectionForm}
          layout="vertical"
          onFinish={saveConnection}
          disabled={busy}
        >
          <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="base_url" label="New API 地址" rules={[{ required: true, type: 'url' }]}>
            <Input placeholder="https://newapi.example.com" />
          </Form.Item>
          <Form.Item name="kind" hidden>
            <Input />
          </Form.Item>
          <Form.Item label="管理员身份">
            <Radio.Group
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              options={[
                { value: 'account', label: '账号 / 邮箱' },
                { value: 'id', label: 'User ID' },
              ]}
            />
          </Form.Item>
          {identity === 'account' ? (
            <>
              <Form.Item name="admin_account" label="管理员账号 / 邮箱" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="password" label="管理员密码（新连接必填，编辑留空保留）">
                <Input.Password autoComplete="off" />
              </Form.Item>
              <Form.Item name="login_code" label="登录 2FA（如果要求）">
                <Input.Password autoComplete="one-time-code" />
              </Form.Item>
            </>
          ) : (
            <Form.Item name="user_id" label="管理员 User ID" rules={[{ required: true }]}>
              <InputNumber min={1} />
            </Form.Item>
          )}
          <Form.Item name="access_token" label="管理员 Access Token" rules={[{ required: !editor?.project }]}>
            <Input.Password autoComplete="off" placeholder={editor?.project ? '留空保留原凭据' : ''} />
          </Form.Item>
          <Alert
            type="info"
            title="保存时选择存储位置"
            description="账号解析需要访问 New API；选择浏览器本地时由本机 Worker 完成。密码和验证码不保存。"
          />
        </Form>
      </Drawer>
      <Drawer title="巡检设置" open={Boolean(settings)} onClose={() => setSettings(undefined)} size={600}>
        <Form name="project-plan" form={planForm} layout="vertical" onFinish={savePlan} disabled={busy}>
          <Form.Item name="mode" label="渠道范围">
            <Select
              options={[
                { value: 'all', label: '全部渠道' },
                { value: 'groups', label: '指定分组' },
                { value: 'channels', label: '指定渠道' },
              ]}
            />
          </Form.Item>
          {planMode === 'groups' && (
            <Form.Item name="groups" label="分组">
              <Select mode="multiple" options={settings?.groups.map((value) => ({ value, label: value }))} />
            </Form.Item>
          )}
          {planMode === 'channels' && (
            <Form.Item name="channel_ids" label="渠道">
              <Select mode="multiple" options={settings?.channels.map((ch) => ({ value: ch.id, label: ch.name }))} />
            </Form.Item>
          )}
          <Form.Item name="models" label="模型 ID（留空使用渠道模型）">
            <Select mode="tags" tokenSeparators={[',', ' ', '\n']} />
          </Form.Item>
          <Form.Item name="evaluators" label="巡检引擎" rules={[{ required: true, type: 'array', min: 1 }]}>
            <Checkbox.Group options={engines.map((e) => ({ value: e.id, label: e.name }))} />
          </Form.Item>
          {engines
            .filter((e) => planEngines.includes(e.id))
            .map((e) => (
              <div key={e.id}>
                {e.options?.map((option) => (
                  <Form.Item
                    key={option.key}
                    name={['evaluator_options', e.id, option.key]}
                    label={`${e.name} · ${option.label}`}
                    initialValue={option.default}
                  >
                    {option.kind === 'select' ? (
                      <Select options={option.choices} />
                    ) : (
                      <InputNumber min={option.min} max={option.max} />
                    )}
                  </Form.Item>
                ))}
              </div>
            ))}
          <Form.Item name="interval_minutes" label="执行间隔（分钟）">
            <InputNumber min={1} max={10080} />
          </Form.Item>
          <Form.Item name="enabled" label="启用定时巡检（云端或自建 Worker）" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<CalendarOutlined />}>
            保存设置
          </Button>
        </Form>
      </Drawer>
      <Modal
        title="同步渠道"
        open={Boolean(syncProject)}
        onCancel={() => setSyncProject(undefined)}
        onOk={() => syncForm.submit()}
        confirmLoading={busy}
        okText="选择位置并同步"
      >
        <Form name="project-sync" form={syncForm} layout="vertical" onFinish={sync}>
          <Form.Item name="import_keys" valuePropName="checked">
            <Checkbox>同时导入渠道 Key</Checkbox>
          </Form.Item>
          <Form.Item name="two_factor_code" label="导入 Key 时填写当前 2FA 验证码">
            <Input.Password autoComplete="one-time-code" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="导入渠道密钥"
        open={Boolean(keyProject)}
        onCancel={() => setKeyProject(undefined)}
        onOk={() => keyForm.submit()}
        confirmLoading={busy}
        okText="选择保存位置"
      >
        <Form name="project-keys" form={keyForm} layout="vertical" onFinish={importKeys}>
          <Form.Item
            name="code"
            label="管理员当前 2FA 验证码"
            rules={[{ required: true, pattern: /^\d{6}$/, message: '请输入 6 位验证码' }]}
          >
            <Input.Password autoComplete="one-time-code" />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={
          <Space>
            测试报告 · {report?.channel.name}
            <SourceTag source={report?.project.source} />
          </Space>
        }
        open={Boolean(report)}
        onClose={() => setReport(undefined)}
        size={1000}
      >
        <Table<{ run: BatchRun; item: BatchRun['items'][number] }>
          rowKey={(row) => `${row.run.id}:${row.item.evaluator}`}
          dataSource={history}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '时间', render: (_, row) => date(row.run.created_at) },
            {
              title: '引擎',
              render: (_, row) => engines.find((e) => e.id === row.item.evaluator)?.name || row.item.evaluator,
            },
            { title: '模型', render: (_, row) => row.item.models.join('、') },
            { title: '状态', render: (_, row) => statuses[row.item.status] || row.item.status },
            { title: '错误', render: (_, row) => row.item.error || row.item.result?.error || '—' },
            {
              title: '详情',
              render: (_, row) => <Button onClick={() => onOpenLogs({ kind: 'batch', id: row.run.id, source: row.run.source })}>查看批次</Button>,
            },
          ]}
        />
      </Drawer>
      <Layout.Footer className="app-footer">
        各来源分别保存项目和最近 50 个批次；浏览器本地仅支持手动执行。
      </Layout.Footer>
    </Layout>
  )
}
