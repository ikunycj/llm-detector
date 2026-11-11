import { CalendarOutlined, CloudSyncOutlined, EditOutlined, KeyOutlined, LogoutOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, Badge, Button, Card, Checkbox, Col, Descriptions, Drawer, Empty, Flex, Form, Input, InputNumber, Layout, Modal, Popconfirm, Row, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, deleteInspectionProject, getEvaluators, getInspectionProjects, getInspectionRuns, importInspectionKeys, logout, runInspectionBatch, runInspectionProject, saveInspectionChannelProtocol, saveInspectionPlan, saveInspectionProject, syncInspectionProject } from '../../api'
import type { AppPage, Evaluator } from '../../types'
import Results from '../scans/Results'
import type { BatchRun, InspectionPlan, InspectionProject, ProjectChannel, ProjectInput } from './types'

const { Header, Content, Footer } = Layout
const { Text, Title, Paragraph } = Typography
const statusLabels: Record<string, string> = { running: '执行中', pending: '等待执行', completed: '已完成', completed_with_errors: '完成 · 存在错误', failed: '失败', interrupted: '已中断', error: '无法执行' }
const protocolLabels: Record<string, string> = { chat_completions: 'OpenAI Chat Completions', responses: 'OpenAI Responses', messages: 'Anthropic Messages' }
const formatTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '—'

// App provides Ant Design's contextual notifications without introducing global state.
export default function InspectionPage(props: { token: string; onExpired: () => void; onLogout: () => void; onNavigate: (page: AppPage) => void }) {
  return <AntApp><InspectionWorkbench {...props} /></AntApp>
}

function InspectionWorkbench({ token, onExpired, onLogout, onNavigate }: { token: string; onExpired: () => void; onLogout: () => void; onNavigate: (page: AppPage) => void }) {
  const { message } = AntApp.useApp()
  const [projects, setProjects] = useState<InspectionProject[]>([])
  const [runs, setRuns] = useState<BatchRun[]>([])
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [enginesLoaded, setEnginesLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selectedProjects, setSelectedProjects] = useState<string[]>([])
  const [editor, setEditor] = useState<{ id?: string } | null>(null)
  const [identityMode, setIdentityMode] = useState<'account' | 'id'>('account')
  const [syncID, setSyncID] = useState<string>()
  const [syncForm] = Form.useForm<{ import_keys: boolean; two_factor_code: string }>()
  const [configForm] = Form.useForm<ProjectInput>()
  const [planForm] = Form.useForm<InspectionPlan>()
  const [keyForm] = Form.useForm<{ code: string }>()
  const [channelID, setChannelID] = useState<string>()
  const [settingsID, setSettingsID] = useState<string>()
  const [channelGroup, setChannelGroup] = useState<string>()
  const [channelTag, setChannelTag] = useState<string>()
  const [channelPage, setChannelPage] = useState(1)
  const [channelPageSize, setChannelPageSize] = useState(10)
  const [channelError, setChannelError] = useState('')
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])
  const [keyDialog, setKeyDialog] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [runID, setRunID] = useState<string>()
  const [runProject, setRunProject] = useState<string>()
  const planMode = Form.useWatch('mode', planForm)
  const planEvaluatorIDs = Form.useWatch<InspectionPlan['evaluators']>('evaluators', planForm) || []
  const channelDetail = projects.find((p) => p.id === channelID)
  const settingsDetail = projects.find((p) => p.id === settingsID)
  const currentRun = runs.find((r) => r.id === runID)
  const visibleChannels = channelDetail?.channels.filter((ch) => (!channelGroup || ch.groups.includes(channelGroup)) && (!channelTag || ch.tag === channelTag)) || []
  const availableEvaluatorIDs = new Set(engines.map((engine) => engine.id))
  const unavailablePlanEvaluatorIDs = enginesLoaded ? planEvaluatorIDs.filter((id) => !availableEvaluatorIDs.has(id)) : []


  const reportError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(); return }
    setError(err instanceof Error ? err.message : '操作失败')
  }, [onExpired])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [p, r] = await Promise.all([getInspectionProjects(token, signal), getInspectionRuns(token, signal)])
    if (signal?.aborted) return
    setProjects(p.projects); setRuns(r.runs); setLoaded(true)
  }, [token])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function update() {
      try { await refresh(controller.signal) }
      catch (err) { if (!controller.signal.aborted) reportError(err) }
      if (!controller.signal.aborted) timer = setTimeout(update, 5000)
    }
    void update()
    getEvaluators(token, controller.signal).then((r) => { if (!controller.signal.aborted) { setEngines(r.evaluators); setEnginesLoaded(true) } }).catch((err: unknown) => { if (!controller.signal.aborted) reportError(err) })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh, token, reportError, revision])

  async function action(name: string, work: () => Promise<void>) {
    setBusy(name); setError('')
    try { await work(); await refresh() } catch (err) { reportError(err) } finally { setBusy('') }
  }
  async function signOut() {
    setBusy('logout'); setError('')
    try { await logout(token); onLogout() } catch (err) { reportError(err) } finally { setBusy('') }
  }
  function openSync(id: string) { syncForm.resetFields(); syncForm.setFieldsValue({ import_keys: true, two_factor_code: '' }); setSyncID(id) }
  async function sync(values: { import_keys: boolean; two_factor_code: string }) {
    if (!syncID) return
    await action('sync-project', async () => {
      const updated = await syncInspectionProject(token, syncID, { ...values, two_factor_code: values.two_factor_code || '' })
      syncForm.resetFields(); setSyncID(undefined); setSelectedChannels([]); setChannelGroup(undefined); setChannelPage(1)
      if (updated.last_error) setError(updated.last_error)
      else void message.success(values.import_keys ? '渠道与可用密钥已同步' : '渠道元数据已同步')
    })
  }
  function edit(project?: InspectionProject) {
    configForm.resetFields()
    configForm.setFieldsValue({ name: project?.name || '', kind: project?.kind || 'newapi', base_url: project?.base_url || '', user_id: project?.user_id || 1, admin_account: project?.admin_account || '', password: '', login_code: '', access_token: '' })
    setIdentityMode(project && !project.admin_account ? 'id' : 'account')
    setEditor(project ? { id: project.id } : {})
  }
  function openChannels(project: InspectionProject) {
    setChannelID(project.id); setSelectedChannels([])
    setChannelGroup(undefined); setChannelTag(undefined); setChannelPage(1); setChannelError(''); setKeyError('')
  }
  function openSettings(project: InspectionProject) {
    setSettingsID(project.id)
    planForm.resetFields(); planForm.setFieldsValue(project.plan)
  }
  async function saveConnection(input: ProjectInput) {
    await action('save-project', async () => {
      await saveInspectionProject(token, { ...input, admin_account: identityMode === 'account' ? input.admin_account : '', user_id: identityMode === 'id' ? input.user_id : 0, password: identityMode === 'account' ? input.password : '', login_code: identityMode === 'account' ? input.login_code : '', access_token: input.access_token || '' }, editor?.id)
      configForm.resetFields(); setEditor(null)
      void message.success('连接已保存，可在渠道页同步并导入密钥')
    })
  }
  async function importKeys(values: { code: string }) {
    if (!channelDetail) return
    setBusy('import-keys'); setKeyError('')
    try {
      const updated = await importInspectionKeys(token, channelDetail.id, selectedChannels, values.code || '')
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project))
      const errors = updated.channels.filter((ch) => selectedChannels.includes(ch.id) && ch.key_error)
      if (errors.length) {
        setKeyError(`${errors.length} 个渠道导入失败：${errors.map((ch) => `${ch.name} (#${ch.id})：${ch.key_error}`).join('；')}。成功项已保存。`)
        setSelectedChannels(errors.map((ch) => ch.id))
      } else {
        setKeyDialog(false); setSelectedChannels([])
        void message.success('渠道密钥已加密保存')
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired()
      else setKeyError(err instanceof Error ? err.message : '密钥导入失败')
    } finally {
      keyForm.resetFields(); setBusy('')
    }
  }
  async function runProjectNow(projectID: string) {
    await action(`run-${projectID}`, async () => {
      const run = await runInspectionProject(token, projectID)
      setRunID(run.id)
    })
  }

  async function batchRun() {
    await action('batch-run', async () => {
      const response = await runInspectionBatch(token, selectedProjects)
      const failed = response.outcomes.filter((outcome) => outcome.error)
      const created = response.outcomes.filter((outcome) => outcome.run_id).length
      if (failed.length) setError(`已启动 ${created} 个项目；${failed.map((item) => `${projects.find((p) => p.id === item.project_id)?.name || item.project_id}：${item.error}`).join('；')}`)
      else void message.success(`已启动 ${created} 个项目的巡检批次`)
    })
  }

  async function changeChannelProtocol(channelID: string, protocol: string) {
    if (!channelDetail) return
    setBusy(`protocol-${channelID}`); setChannelError('')
    try {
      const updated = await saveInspectionChannelProtocol(token, channelDetail.id, channelID, protocol)
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project))
      void message.success('测试协议已保存，仅影响本服务巡检')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired()
      else setChannelError(err instanceof Error ? err.message : '测试协议保存失败')
    } finally { setBusy('') }
  }

  const channelColumns = [
    { title: '渠道', key: 'name', width: 220, render: (_: unknown, ch: ProjectChannel) => <Space orientation="vertical" size={2} style={{ width: '100%', minWidth: 0 }}><Text strong ellipsis={{ tooltip: `${ch.name} · #${ch.id}` }}>{ch.name} · #{ch.id}</Text><Text type="secondary" ellipsis={{ tooltip: ch.base_url || '无地址' }}>{ch.base_url || '无地址'}</Text></Space> },
    { title: '所属分组', key: 'groups', width: 160, render: (_: unknown, ch: ProjectChannel) => <Space wrap>{ch.groups.map((g) => <Tag key={g}>{g}</Tag>)}</Space> },
    { title: '标签', key: 'tag', width: 180, render: (_: unknown, ch: ProjectChannel) => ch.tag ? <Text style={{ display: 'block', maxWidth: '100%' }} ellipsis={{ tooltip: ch.tag }}>{ch.tag}</Text> : '—' },
    { title: '测试协议', key: 'protocol', width: 230, render: (_: unknown, ch: ProjectChannel) => <Space orientation="vertical" size={4} style={{ width: '100%', minWidth: 0 }}>
      <Select aria-label={`渠道 ${ch.id} 的测试协议`} style={{ width: '100%' }} disabled={channelDetail?.busy || Boolean(busy)} loading={busy === `protocol-${ch.id}`} value={ch.protocol_override || ''} onChange={(protocol) => void changeChannelProtocol(ch.id, protocol)} options={[
        { value: '', label: `跟随渠道：${protocolLabels[ch.protocol] || ch.protocol || '未识别'}` },
        { value: 'chat_completions', label: protocolLabels.chat_completions },
        { value: 'responses', label: protocolLabels.responses },
        { value: 'messages', label: protocolLabels.messages },
      ]} />
      {ch.protocol_override && <Text type="secondary">同步协议：{protocolLabels[ch.protocol] || ch.protocol || '未识别'}</Text>}
      {ch.organization && <Tag>已配置 OpenAI Organization</Tag>}
    </Space> },
    { title: '可用性', key: 'state', width: 130, render: (_: unknown, ch: ProjectChannel) => <Space orientation="vertical" size={4} style={{ width: '100%', minWidth: 0 }}><Tag color={ch.enabled ? 'success' : 'default'}>{ch.enabled ? '启用' : '停用'}</Tag>{ch.issue && <Text type="danger">{ch.issue}</Text>}</Space> },
    { title: '密钥状态', key: 'key', width: 150, render: (_: unknown, ch: ProjectChannel) => <Space orientation="vertical" size={4} style={{ width: '100%', minWidth: 0 }}><Tag color={ch.key_error ? 'error' : ch.has_key ? 'success' : 'warning'}>{ch.key_error ? '导入失败' : ch.has_key ? '已导入密钥' : '尚未导入密钥'}</Tag>{ch.key_error && <Text type="danger">{ch.key_error}</Text>}</Space> },
    { title: '模型', key: 'models', width: 300, render: (_: unknown, ch: ProjectChannel) => <Space orientation="vertical" size={2} style={{ width: '100%', minWidth: 0 }}><Text ellipsis={{ tooltip: ch.models.join('、') }}>{ch.models.join('、') || '未配置模型'}</Text>{ch.multi_key && <Text type="secondary" ellipsis={{ tooltip: '多 Key：导入第一个可用 Key' }}>多 Key：导入第一个可用 Key</Text>}</Space> },
  ]

  return <Layout className="app-layout">
    <Header className="app-header">
      <Space className="brand" size={12}><span className="brand-mark" aria-hidden="true">L</span><Text strong>LLM Detector</Text><Text type="secondary">/ 巡检任务</Text></Space>
      <Space><Segmented value="tasks" onChange={(value) => onNavigate(value as AppPage)} options={[{ label: '模型巡检', value: 'scan' }, { label: '巡检任务', value: 'tasks' }, { label: '巡检引擎', value: 'engines' }]} /><Button type="text" icon={<LogoutOutlined />} disabled={Boolean(busy)} onClick={() => void signOut()}>退出登录</Button></Space>
    </Header>
    <Content className="app-content inspection-content">
      <Flex justify="space-between" align="center" wrap gap={16} className="page-heading">
        <div><Title level={1}>巡检任务</Title><Text type="secondary">从项目同步分组与渠道，由服务端批量检测并按间隔巡检。</Text></div>
        <Space><Button icon={<ReloadOutlined />} disabled={Boolean(busy)} onClick={() => setRevision((n) => n + 1)}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>添加项目</Button></Space>
      </Flex>
      {error && <Alert type="error" title={error} showIcon closable onClose={() => setError('')} />}
      <Alert type="info" showIcon title="按分组选择渠道，直接检测上游" description="项目连接与渠道密钥加密保存在本服务。定时批次使用最近同步的渠道快照，与浏览器是否打开无关；本服务需要保持运行。New API 的分组用于筛选渠道，不代表网关分组路由测试。" />
      <Flex gap={16} align="center" className="inspection-toolbar"><Checkbox checked={projects.length > 0 && selectedProjects.length === projects.length} indeterminate={selectedProjects.length > 0 && selectedProjects.length < projects.length} onChange={(e) => setSelectedProjects(e.target.checked ? projects.map((p) => p.id) : [])}>选择全部项目</Checkbox><Popconfirm title="确认批量立即巡检？" description="将按各项目当前设置发起真实模型请求，可能消耗额度。" onConfirm={() => void batchRun()} okText="确认巡检" cancelText="取消"><Button icon={<PlayCircleOutlined />} disabled={!selectedProjects.length || Boolean(busy)} loading={busy === 'batch-run'}>批量立即巡检（{selectedProjects.length}）</Button></Popconfirm></Flex>
      {!projects.length ? <Card loading={!loaded}><Empty description="添加 New API 项目后，打开渠道页同步渠道，并在设置中配置巡检计划。" /></Card> : <Row gutter={[20, 20]}>
        {projects.map((p) => <Col key={p.id} xs={24} xl={12}>
          <Card className="inspection-project-card" title={<Space><Checkbox checked={selectedProjects.includes(p.id)} onChange={(e) => setSelectedProjects((current) => e.target.checked ? [...current, p.id] : current.filter((id) => id !== p.id))} aria-label={`选择项目 ${p.name}`} /><Text strong>{p.name}</Text><Tag>New API</Tag></Space>} extra={<Badge status={p.busy ? 'processing' : p.plan.enabled ? 'success' : 'default'} text={p.busy ? '执行中' : p.plan.enabled ? '定时已启用' : '手动运行'} />}>
            <Descriptions size="small" column={1} items={[
              { key: 'url', label: '项目地址', children: p.base_url },
              { key: 'channels', label: '已同步', children: `${p.groups.length} 个分组 · ${p.channels.length} 个渠道 · ${p.channels.filter((ch) => ch.has_key).length} 个已导入密钥` },
              { key: 'synced', label: '同步时间', children: formatTime(p.synced_at) },
              { key: 'next', label: '下次巡检', children: p.plan.enabled ? `${formatTime(p.next_run_at)}（每 ${p.plan.interval_minutes} 分钟）` : '未启用' },
            ]} />
            {p.last_error && <Alert type="error" title={p.last_error} />}
            <Space wrap className="inspection-actions">
              <Button icon={<CloudSyncOutlined />} disabled={p.busy || Boolean(busy)} onClick={() => openChannels(p)}>渠道</Button>
              <Button icon={<SettingOutlined />} disabled={!enginesLoaded || p.busy || Boolean(busy)} onClick={() => openSettings(p)}>设置</Button>
              <Popconfirm title="确认立即巡检？" description="将按当前设置向已选渠道发起真实模型请求，可能消耗额度。" onConfirm={() => void runProjectNow(p.id)} okText="确认巡检" cancelText="取消"><Button type="primary" icon={<PlayCircleOutlined />} disabled={p.busy || Boolean(busy) || !p.synced_at} loading={busy === `run-${p.id}`}>立即巡检</Button></Popconfirm>
              <Button type="text" icon={<EditOutlined />} disabled={p.busy || Boolean(busy)} onClick={() => edit(p)}>编辑连接</Button>
              <Popconfirm title="删除此项目连接、计划与已导入密钥？" description="已完成的批次记录保留。" onConfirm={() => action(`delete-${p.id}`, async () => { await deleteInspectionProject(token, p.id); setSelectedProjects((ids) => ids.filter((id) => id !== p.id)); if (channelID === p.id) setChannelID(undefined); if (settingsID === p.id) setSettingsID(undefined) })} okText="删除" cancelText="取消"><Button type="text" danger disabled={p.busy || Boolean(busy)}>删除</Button></Popconfirm>
            </Space>
          </Card>
        </Col>)}
      </Row>}
      <Card className="inspection-run-list" title="巡检批次" extra={<Select allowClear value={runProject} onChange={setRunProject} placeholder="按项目筛选" options={[...new Map(runs.map((run) => [run.project_id, { value: run.project_id, label: run.project_name }])).values()]} style={{ width: 200 }} />}>
        <Table rowKey="id" size="small" dataSource={runs.filter((run) => !runProject || run.project_id === runProject)} pagination={{ pageSize: 10 }} scroll={{ x: 760 }} columns={[
          { title: '项目 / 批次', key: 'project', render: (_, run) => <Space orientation="vertical" size={0}><Text strong>{run.project_name}</Text><Text type="secondary">{run.id}</Text></Space> },
          { title: '触发', dataIndex: 'trigger', render: (value: string) => value === 'schedule' ? '定时' : '手动' },
          { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={value === 'completed' ? 'success' : value === 'running' ? 'processing' : 'warning'}>{statusLabels[value] || value}</Tag> },
          { title: '进度', key: 'progress', render: (_, run) => `${run.items.filter((i) => !['pending', 'running'].includes(i.status)).length}/${run.items.length}` },
          { title: '创建时间', dataIndex: 'created_at', render: formatTime },
          { title: '操作', key: 'action', render: (_, run) => <Button type="link" onClick={() => setRunID(run.id)}>查看结果</Button> },
        ]} />
      </Card>
    </Content>
    <Footer className="app-footer">每个项目最多保留 50 个批次。重启后的定时计划从下一个间隔开始，未完成批次标记为中断。</Footer>

    <Modal title="同步渠道" open={Boolean(syncID)} onCancel={() => { setSyncID(undefined); syncForm.resetFields() }} onOk={() => syncForm.submit()} confirmLoading={busy === 'sync-project'} okText="开始同步" cancelText="取消">
      <Form form={syncForm} layout="vertical" onFinish={sync}>
        <Form.Item name="import_keys" valuePropName="checked"><Checkbox>同步导入密钥</Checkbox></Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.import_keys !== current.import_keys}>
          {({ getFieldValue }) => getFieldValue('import_keys') ? <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="导入 Key 受目标 New API 的安全验证和限流保护" description="导入 Key 必须填写该管理员当前的 2FA 验证码。渠道较多时可能触发目标 New API 限流，成功项会保存，失败项可随后重试。只支持 Passkey 的账号无法由当前服务自动完成验证。" /> : null}
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.import_keys !== current.import_keys}>
          {({ getFieldValue }) => getFieldValue('import_keys') ? <Form.Item name="two_factor_code" label="2FA验证码" rules={[{ required: true, message: '请输入 2FA 验证码' }, { pattern: /^\d{6}$/, message: '请输入 6 位验证码' }]}><Input.Password autoComplete="one-time-code" maxLength={6} /></Form.Item> : null}
        </Form.Item>
      </Form>
    </Modal>

    <Modal title={editor?.id ? '编辑项目连接' : '添加项目连接'} open={editor !== null} onCancel={() => { setEditor(null); configForm.resetFields() }} onOk={() => configForm.submit()} confirmLoading={busy === 'save-project'} okText="保存连接" cancelText="取消">
      <Form form={configForm} layout="vertical" onFinish={saveConnection} requiredMark={false}>
        <Form.Item name="kind" label="项目类型" rules={[{ required: true }]}><Select options={[{ value: 'newapi', label: 'New API' }]} /></Form.Item>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input placeholder="例如：生产 New API" /></Form.Item>
        <Form.Item name="base_url" label="项目根地址" extra="填写管理站点根地址，不是 /v1 模型接口地址。" rules={[{ required: true }, { type: 'url' }]}><Input placeholder="https://newapi.example.com" autoComplete="off" /></Form.Item>
        <Form.Item label="管理员识别方式"><Segmented value={identityMode} onChange={(value) => setIdentityMode(value as 'account' | 'id')} options={[{ label: '账号 / 邮箱', value: 'account' }, { label: '高级：User ID', value: 'id' }]} /></Form.Item>
        {identityMode === 'account' ? <>
          <Form.Item name="admin_account" label="管理员账号 / 邮箱" rules={[{ required: true, whitespace: true }]}><Input autoComplete="username" /></Form.Item>
          <Form.Item name="password" label="登录密码（仅解析 ID，不保存）" extra={editor?.id ? '仅修改名称时可留空；更换账号、地址或令牌时需重新登录解析。' : '通过目标 New API 登录接口确认身份，不需手工查找 User ID。'} rules={[{ required: !editor?.id }]}><Input.Password autoComplete="off" /></Form.Item>
          <Form.Item name="login_code" label="登录 2FA 验证码（若启用）"><Input.Password autoComplete="one-time-code" /></Form.Item>
        </> : <Form.Item name="user_id" label="New-Api-User（管理员 User ID）" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>}
        <Form.Item name="access_token" label="管理员 Access Token" extra={editor?.id ? '留空保留原令牌；修改地址或用户时必须重新填写。' : '从 New API 个人设置获取管理访问令牌。普通 sk- 模型令牌不能管理渠道。'} rules={[{ required: !editor?.id }]}><Input.Password autoComplete="off" /></Form.Item>
        <Alert type="info" showIcon title="凭据加密保存在本服务，接口不回显。保存连接不会自动发起模型调用。" />
      </Form>
    </Modal>

    <Drawer title={`${channelDetail?.name || '项目'} · 渠道`} open={Boolean(channelID)} onClose={() => setChannelID(undefined)} width={1000}>
      {channelDetail && <>
        {channelError && <Alert type="error" showIcon title={channelError} />}
        <Flex gap={12} align="center" wrap className="inspection-toolbar">
          <Select aria-label="按所属分组筛选渠道" allowClear showSearch optionFilterProp="label" placeholder="全部分组" value={channelGroup} style={{ minWidth: 180 }} disabled={channelDetail.busy || Boolean(busy)} onChange={(group) => { setChannelGroup(group); setChannelPage(1); setSelectedChannels([]) }} options={channelDetail.groups.map((group) => ({ value: group, label: group }))} />
          <Select aria-label="按渠道标签筛选" allowClear showSearch optionFilterProp="label" placeholder="全部标签" value={channelTag} style={{ minWidth: 180 }} disabled={channelDetail.busy || Boolean(busy)} onChange={(tag) => { setChannelTag(tag); setChannelPage(1); setSelectedChannels([]) }} options={[...new Set(channelDetail.channels.map((ch) => ch.tag).filter((tag): tag is string => Boolean(tag)))].sort().map((tag) => ({ value: tag, label: tag }))} />
          <Button type="primary" icon={<CloudSyncOutlined />} disabled={channelDetail.busy || Boolean(busy)} onClick={() => openSync(channelDetail.id)}>同步渠道</Button>
          <Button icon={<KeyOutlined />} disabled={channelDetail.busy || Boolean(busy) || !selectedChannels.length} onClick={() => { keyForm.resetFields(); setKeyError(''); setKeyDialog(true) }}>导入选中渠道的密钥（{selectedChannels.length}）</Button>
        </Flex>
        <Table<ProjectChannel> rowKey="id" size="small" tableLayout="fixed" dataSource={visibleChannels} columns={channelColumns} rowSelection={{ selectedRowKeys: selectedChannels, onChange: (keys) => setSelectedChannels(keys.map(String)), getCheckboxProps: (ch) => ({ disabled: !ch.enabled || Boolean(ch.issue) || channelDetail.busy || Boolean(busy) }) }} pagination={{ current: channelPage, pageSize: channelPageSize, total: visibleChannels.length, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 个渠道`, onChange: (page, size) => { setChannelPage(size === channelPageSize ? page : 1); setChannelPageSize(size) } }} scroll={{ x: 1420 }} />
      </>}
    </Drawer>

    <Drawer title={`${settingsDetail?.name || '项目'} · 设置`} open={Boolean(settingsID)} onClose={() => setSettingsID(undefined)} width={760}>
      {settingsDetail && <Form form={planForm} layout="vertical" disabled={settingsDetail.busy || Boolean(busy)} onFinish={(plan: InspectionPlan) => action('save-plan', async () => { await saveInspectionPlan(token, settingsDetail.id, { ...plan, evaluator_options: Object.fromEntries(Object.entries(plan.evaluator_options || {}).filter(([id]) => plan.evaluators.includes(id))) }); void message.success('设置已保存') })}>
        <Form.Item name="mode" label="巡检范围"><Select options={[{ value: 'all', label: '全部启用渠道' }, { value: 'groups', label: '按分组选择渠道' }, { value: 'channels', label: '指定渠道' }]} /></Form.Item>
        {planMode === 'groups' && <Form.Item name="groups" label="分组" rules={[{ required: true }]}><Select mode="multiple" options={settingsDetail.groups.map((group) => ({ value: group, label: group }))} /></Form.Item>}
        {planMode === 'channels' && <Form.Item name="channel_ids" label="渠道" rules={[{ required: true }]}><Select mode="multiple" options={settingsDetail.channels.map((ch) => ({ value: ch.id, label: `${ch.name} (#${ch.id})`, disabled: !ch.enabled }))} /></Form.Item>}
        <Form.Item name="models" label="限定模型 ID（可选）" extra="留空使用各渠道配置的全部模型；指定时取与该渠道模型列表的交集。模型映射后的上游 ID 会显示在渠道表中。"><Select mode="tags" tokenSeparators={[',', '，']} options={[...new Set(settingsDetail.channels.flatMap((ch) => ch.models))].map((model) => ({ value: model, label: model }))} /></Form.Item>
        <Form.Item name="evaluators" label="巡检引擎" extra="与“巡检引擎”页面使用同一份引擎列表，可同时选择多个。" rules={[{ required: true, message: '至少选择一个巡检引擎' }]}>
          {engines.length ? <Checkbox.Group options={[...engines.map((engine) => ({ value: engine.id, label: engine.name })), ...unavailablePlanEvaluatorIDs.map((id) => ({ value: id, label: `${id}（已停用，请取消勾选）` }))]} /> : <Alert type="warning" showIcon title="暂无可用巡检引擎" description="请确认服务端已注册检测引擎，并刷新页面重试。" />}
        </Form.Item>
        {unavailablePlanEvaluatorIDs.length > 0 && <Alert type="warning" showIcon title="计划包含当前未注册的引擎" description="请取消勾选已停用引擎，选择需要的检测方式后保存。" />}
        {engines.filter((engine) => planEvaluatorIDs.includes(engine.id) && engine.options?.length).map((engine) => <Card key={engine.id} size="small" title={engine.name} className="inspection-engine-options">
          {engine.options?.map((option) => <Form.Item key={option.key} name={['evaluator_options', engine.id, option.key]} label={option.label} initialValue={option.default} rules={[{ required: true, message: `请填写${option.label}` }]}>
            {option.kind === 'select' ? <Select options={option.choices} /> : <InputNumber min={option.min} max={option.max} precision={0} style={{ width: '100%' }} />}
          </Form.Item>)}
        </Card>)}
        <Form.Item name="interval_minutes" label="执行间隔（分钟）" rules={[{ required: true }]}><InputNumber min={1} max={10080} precision={0} /></Form.Item>
        <Form.Item name="enabled" label="启用服务端定时巡检" valuePropName="checked"><Switch /></Form.Item>
        <Alert type="warning" showIcon title="启用后会按计划向上游模型发起真实请求并消耗额度。每个项目内部串行执行，同一项目不重叠运行。" />
        <Button className="inspection-actions" type="primary" htmlType="submit" icon={<CalendarOutlined />} loading={busy === 'save-plan'} disabled={!engines.length || unavailablePlanEvaluatorIDs.length > 0}>保存设置</Button>
      </Form>}
    </Drawer>

    <Modal title="导入渠道密钥" open={keyDialog} closable={busy !== 'import-keys'} maskClosable={busy !== 'import-keys'} keyboard={busy !== 'import-keys'} cancelButtonProps={{ disabled: busy === 'import-keys' }} onCancel={() => { setKeyDialog(false); setKeyError(''); keyForm.resetFields() }} onOk={() => keyForm.submit()} confirmLoading={busy === 'import-keys'} okText={keyError ? '重新验证并导入' : '验证并导入'} cancelText="取消">
      <Paragraph>通过 New API 正式的渠道 Key 接口读取并加密保存 {selectedChannels.length} 个渠道的密钥。项目的 Access Token 必须属于有权读取 Key 的 Root 管理员。</Paragraph>
      <Paragraph type="secondary">导入 Key 必须填写该管理员当前的 6 位 2FA 验证码；已在另一个浏览器登录或验证不会替本服务完成验证。</Paragraph>
      {keyError && <Alert type="error" showIcon title="密钥导入未完成" description={keyError} />}
      <Form form={keyForm} layout="vertical" disabled={busy === 'import-keys'} onFinish={importKeys}><Form.Item name="code" label="该管理员当前的 2FA 验证码" rules={[{ required: true, message: '导入 Key 时必须填写 2FA 验证码' }, { pattern: /^\d{6}$/, message: '请输入 6 位验证码' }]}><Input.Password autoComplete="one-time-code" maxLength={6} placeholder="仅用于本次验证，不保存" /></Form.Item></Form>
      <Text type="secondary">不支持绕过权限或 Passkey 验证。如果目标只允许 Passkey，请由 New API 管理员提供允许机器访问的正式接入方式。</Text>
    </Modal>

    <Drawer title={`批次详情 · ${currentRun?.project_name || ''}`} open={Boolean(runID)} onClose={() => setRunID(undefined)} width={1100}>
      {currentRun && <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        <Descriptions column={2} items={[{ key: 'id', label: '批次 ID', children: currentRun.id }, { key: 'status', label: '状态', children: statusLabels[currentRun.status] }, { key: 'start', label: '创建', children: formatTime(currentRun.created_at) }, { key: 'end', label: '完成', children: formatTime(currentRun.completed_at) }]} />
        {currentRun.error && <Alert type="error" title={currentRun.error} />}
        <Table rowKey={(item) => `${item.channel_id}:${item.evaluator}`} size="small" pagination={false} dataSource={currentRun.items} scroll={{ x: 700 }} columns={[
          { title: '渠道', dataIndex: 'channel_name' }, { title: '分组', dataIndex: 'groups', render: (groups: string[]) => groups.join('、') }, { title: '引擎', dataIndex: 'evaluator', render: (id: string) => engines.find((engine) => engine.id === id)?.name || id }, { title: '测试协议', dataIndex: 'protocol', render: (value?: string) => value ? protocolLabels[value] || value : '历史记录未保存' }, { title: '模型', dataIndex: 'models', render: (models: string[]) => models.join('、') }, { title: '状态', dataIndex: 'status', render: (status: string) => statusLabels[status] || status }, { title: '错误', dataIndex: 'error', render: (value?: string) => value ? <Text type="danger">{value}</Text> : '—' },
        ]} />
        <Results scans={currentRun.items.flatMap((item) => item.result ? [item.result] : [])} engines={engines} />
      </Space>}
    </Drawer>
  </Layout>
}
