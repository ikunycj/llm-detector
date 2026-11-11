import { readModelServices, type APIClient, type ExecutionLocation } from '../../api'
import { CodeOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Layout, List, Popconfirm, Progress, Radio, Row, Select, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, cancelBenchJob, createBenchJob, getBenchCatalog, getBenchJobs, getBenchReadiness, logout } from '../../api'
import { type SavedModelService } from '../scans/savedServices'
import type { BenchCatalog, BenchInput, BenchJob, BenchReadiness } from './types'

const { Content, Footer } = Layout
const { Text, Title, Paragraph } = Typography
const descriptions: Record<string, string> = {
  'regex-log': '从包含合法 IPv4 的日志行提取最后一个合法日期，检查字符边界和多日期情形。',
  'constraints-scheduling': '读取三人的 ICS 日历，综合可用时间、会议冲突、缓冲与偏好安排会议。',
  'cobol-modernization': '将 COBOL 交易程序迁移到 Python，保持连续交易和文件更新语义。',
  'cancel-async-tasks': '实现限并发异步执行器，并正确处理 SIGINT、已启动任务与排队任务清理。',
  'log-summary-date-ranges': '跨多个日期范围精确统计日志等级并输出 CSV，避免干扰文本误计数。',
  'db-wal-recovery': '从异常 SQLite 数据库及 WAL 恢复完整记录，验证更新、排序与去重。',
}
const labels: Record<string, string> = { running: '执行中', pending: '等待运行', passed: '通过', failed: '未通过', error: '运行错误', completed: '运行完成', completed_with_errors: '完成 · 含运行错误', cancelling: '正在取消', cancelled: '已取消', interrupted: '已中断' }
const jobLabel = (status: string) => status === 'failed' ? '运行失败' : labels[status] || status
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '—'
const terminal = (status: string) => !['running', 'cancelling'].includes(status)

export default function TerminalBenchPage({ token, localClient, cloudClient, onExpired }: { token: APIClient; localClient: APIClient; cloudClient: APIClient; onExpired: (location?: ExecutionLocation) => void }) {
  const [form] = Form.useForm<BenchInput>()
  const suite = Form.useWatch('suite', form) || 'daily'
  const savedServiceID = Form.useWatch('service_id', form)
  const [catalog, setCatalog] = useState<BenchCatalog>()
  const [execution, setExecution] = useState<ExecutionLocation>(token.mode === 'cloud' ? 'cloud' : 'local')
  const [readiness, setReadiness] = useState<BenchReadiness>()
  const [checking, setChecking] = useState(false)
  const [jobs, setJobs] = useState<BenchJob[]>([])
  const [jobID, setJobID] = useState<string>()
  const [services, setServices] = useState<SavedModelService[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const job = jobs.find((item) => item.id === jobID) || jobs[0]
  const active = jobs.some((item) => !terminal(item.status))
  const reportError = useCallback((err: unknown, location: ExecutionLocation = execution) => {
    if (err instanceof ApiError && err.status === 401) { onExpired(location); return }
    setError(err instanceof Error ? err.message : '操作失败')
  }, [execution, onExpired])

  useEffect(() => {
    setExecution(token.mode === 'cloud' ? 'cloud' : 'local')
  }, [token.mode])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    getBenchCatalog(token, controller.signal).then(setCatalog).catch((err: unknown) => { if (!controller.signal.aborted) reportError(err) })
    readModelServices(token).then(setServices).catch(reportError)
    async function poll() {
      try { const response = await getBenchJobs(token, controller.signal); if (!controller.signal.aborted) setJobs(response.jobs) }
      catch (err) { if (!controller.signal.aborted) reportError(err) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, reportError])

  async function check() {
    setChecking(true); setError('')
    try { const client = execution === 'local' ? localClient : cloudClient; if (execution === 'cloud' && !cloudClient.token) throw new Error('云端执行需要先登录云端。'); setReadiness(await getBenchReadiness(client)) } catch (err) { reportError(err, execution) } finally { setChecking(false) }
  }
  async function start(input: BenchInput) {
    setBusy('start'); setError('')
    try {
      const selected = services.find((service) => service.id === input.service_id)
      if (execution === 'cloud' && !cloudClient.token) throw new Error('云端执行需要先登录云端。')
      if (execution === 'local' && selected?.source === 'cloud') throw new Error('云端保存的 API Key 不会回传浏览器，不能选择本地执行。')
      const client = execution === 'local' ? localClient : cloudClient
      const request: BenchInput = { ...input, service_id: execution === 'cloud' && selected?.source === 'cloud' ? selected.id : undefined, service_name: selected?.name || input.service_name, base_url: selected?.base_url || input.base_url, api_key: selected?.api_key || input.api_key, protocol: selected?.protocol || input.protocol }
      const result = await createBenchJob(client, request)
      setJobs((current) => [result, ...current]); setJobID(result.id)
      form.setFieldValue('api_key', '')
    } catch (err) { reportError(err, execution) } finally { setBusy('') }
  }
  async function cancel() {
    if (!job) return
    setBusy('cancel'); setError('')
    try { const client = job.source === 'cloud' ? cloudClient : localClient; await cancelBenchJob(client, job.id); const response = await getBenchJobs(client); setJobs(response.jobs) }
    catch (err) { reportError(err) } finally { setBusy('') }
  }
  const selectedNames = catalog ? suite === 'daily' ? catalog.daily : catalog.tasks.map((task) => task.name) : []
  const finished = job?.trials.filter((trial) => !['pending', 'running'].includes(trial.status)).length || 0
  const passed = job?.trials.filter((trial) => trial.status === 'passed').length || 0
  const failed = job?.trials.filter((trial) => trial.status === 'failed').length || 0
  const errors = job?.trials.filter((trial) => trial.status === 'error').length || 0

  return <Layout className="engine-embedded-layout">
    <Content className="app-content terminal-bench-content">
      <div className="page-heading"><Title level={1}><CodeOutlined /> Terminal Bench</Title><Text type="secondary">在 Docker 任务环境中运行 Terminus-2 agent，再执行官方 verifier。</Text></div>
      {error && <Alert type="error" title={error} showIcon closable onClose={() => setError('')} />}
      <Alert type="info" showIcon title="固定 Terminal-Bench 2.0 · 完整 89 题 / 日常 6 题" description="两套测试使用同一数据集提交和 Harbor 0.25.0。日常集适合固定配置的重复对比，不能替代完整测试集成绩；结果同时受模型、agent 与运行环境影响。" />
      <Card size="small" title={<Space>运行环境 <Tag color={execution === 'cloud' ? 'blue' : 'default'}>{execution === 'cloud' ? '云端执行' : '本地执行'}</Tag></Space>} extra={<Button icon={<ReloadOutlined />} loading={checking} onClick={() => void check()}>检查环境</Button>}>
        {readiness ? <Space wrap>{readiness.checks.map((item) => <Tag key={item.name} color={item.ready ? 'success' : 'error'}>{item.name}：{item.detail}</Tag>)}</Space> : <Text type="secondary">首次运行前检查 Harbor、Docker 与 Docker Compose。可选依赖安装命令：<Text code>make terminal-bench-install</Text></Text>}
      </Card>
      <Row gutter={[20, 20]} className="terminal-bench-grid">
        <Col xs={24} lg={11}>
          <Card title="测试配置">
            <Form form={form} layout="vertical" requiredMark={false} disabled={Boolean(busy) || active} initialValues={{ suite: 'daily', service_name: '', protocol: 'chat_completions', concurrency: 1, execution: token.mode === 'cloud' ? 'cloud' : 'local' }} onFinish={start}>
              <Form.Item name="execution" label="执行位置"><Select value={execution} onChange={setExecution} options={[{ value: 'local', label: '本机 Harbor', disabled: false }, { value: 'cloud', label: '云端 Harbor', disabled: !cloudClient.token }]} /></Form.Item>
              {execution === 'cloud' && <Alert type="info" showIcon title="本次 Terminal Bench 将在云端执行" description="云端 Harbor 会运行任务并保存结果；本地 Harbor 需要本机执行器和 Docker。" />}
              <Form.Item label="选择模型 API"><Select allowClear placeholder="可选，也可直接填写" options={services.map((service) => ({ value: service.id, label: `${service.name} · ${service.source === 'cloud' ? '云端' : '本地'}` }))} onChange={(id) => { const service = services.find((item) => item.id === id); if (!service) { form.setFieldValue('service_id', undefined); return }; form.setFieldsValue({ service_id: service.id, service_name: service.name, base_url: service.base_url, api_key: service.api_key, protocol: service.protocol }) }} /></Form.Item>
              <Form.Item name="service_name" label="服务名称"><Input placeholder="用于区分测试记录" /></Form.Item>
              <Form.Item name="base_url" label="API Base URL" rules={[{ required: true }, { type: 'url' }]}><Input disabled={Boolean(savedServiceID)} placeholder="https://api.example.com/v1" autoComplete="off" /></Form.Item>
              <Form.Item name="service_id" hidden><Input /></Form.Item><Form.Item name="api_key" label="模型 API Key" rules={[{ required: !savedServiceID }]}><Input.Password autoComplete="off" disabled={Boolean(savedServiceID) && execution === 'cloud'} placeholder={savedServiceID && execution === 'cloud' ? '使用云端已保存密钥' : 'API Key'} /></Form.Item>
              <Form.Item name="protocol" label="协议"><Select disabled={Boolean(savedServiceID)} options={[{ value: 'chat_completions', label: 'OpenAI Chat Completions' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'messages', label: 'Anthropic Messages' }]} /></Form.Item>
              <Form.Item name="model" label="模型 ID" rules={[{ required: true, whitespace: true }]}><Input placeholder="服务实际支持的模型 ID" /></Form.Item>
              <Form.Item name="suite" label="测试集"><Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'daily', label: '日常测试集 · 6 题' }, { value: 'full', label: '完整测试集 · 89 题' }]} /></Form.Item>
              <Form.Item name="concurrency" label="任务并发数" extra="1–4，默认 1。每题只执行一次，不自动重试。" rules={[{ required: true }]}><InputNumber min={1} max={4} precision={0} /></Form.Item>
              <Alert type="warning" showIcon title="启动将执行任务代码、拉取 Docker 镜像并消耗模型额度。完整集可能耗时较长；本服务一次只运行一个批次。" />
              <Button className="terminal-bench-start" type="primary" htmlType="submit" block icon={<PlayCircleOutlined />} loading={busy === 'start'} disabled={active || !readiness?.ready}>{active ? '已有测试运行中' : `开始${suite === 'daily' ? '日常 6 题' : '完整 89 题'}测试`}</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={13}>
          <Card title={suite === 'daily' ? '日常测试集' : '完整测试集'} extra={<Tag>{selectedNames.length} 题</Tag>}>
            <List size="small" className="terminal-bench-task-catalog" dataSource={selectedNames} renderItem={(name) => <List.Item><Space orientation="vertical" size={2}><Text strong>{name}</Text>{descriptions[name] && <Text type="secondary">{descriptions[name]}</Text>}</Space></List.Item>} />
            <Paragraph type="secondary" className="terminal-bench-source">源码固定为 <Text code>{catalog?.tasks[0]?.git_commit_id.slice(0, 12)}</Text>；完整题单来自官方注册表。不会跟随上游 main 自动替换题目。</Paragraph>
          </Card>
        </Col>
      </Row>
      <Card title="运行记录" className="terminal-bench-results" extra={job && !terminal(job.status) && <Popconfirm title="取消当前测试？" description="已消耗的模型额度不会退回，Harbor 会尝试清理容器。" onConfirm={cancel} okText="取消测试" cancelText="继续运行"><Button danger icon={<StopOutlined />} loading={busy === 'cancel'}>取消测试</Button></Popconfirm>}>
        {!jobs.length ? <Empty description="尚未运行测试；启动后会显示逐题进度与 verifier 结果。" /> : <>
          <Select className="terminal-bench-job-select" value={job?.id} onChange={setJobID} options={jobs.map((item) => ({ value: item.id, label: `${date(item.created_at)} · ${item.service_name} / ${item.model} · ${item.suite === 'daily' ? '日常' : '完整'} · ${jobLabel(item.status)}` }))} />
          {job && <>
            <Descriptions size="small" column={{ xs: 1, md: 2 }} items={[{ key: 'id', label: '任务 ID', children: job.id }, { key: 'config', label: '执行配置', children: `${job.dataset} / ${job.agent} / Harbor ${job.harbor_version}` }, { key: 'status', label: '状态', children: jobLabel(job.status) }, { key: 'finished', label: '结束时间', children: date(job.finished_at) }]} />
            {job.error && <Alert type={job.status === 'cancelled' ? 'info' : 'error'} title={job.error} showIcon />}
            <Progress percent={Math.round(finished / job.trials.length * 100)} status={!terminal(job.status) ? 'active' : undefined} format={() => `${finished}/${job.trials.length}`} />
            <Space wrap className="terminal-bench-summary"><Tag color="success">通过 {passed}</Tag><Tag color="warning">未通过 {failed}</Tag><Tag color="error">运行错误 {errors}</Tag><Text type="secondary">运行错误不等同于能力题未通过；未完成题目不记作通过。</Text></Space>
            <Input.Search allowClear placeholder="搜索题目名称" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320, marginBottom: 16 }} />
            <Table rowKey="name" size="small" dataSource={job.trials.filter((trial) => trial.name.includes(query.trim()))} pagination={{ pageSize: 10 }} scroll={{ x: 680 }} columns={[
              { title: '题目', dataIndex: 'name' },
              { title: '状态', dataIndex: 'status', render: (status: string) => <Tag color={status === 'passed' ? 'success' : status === 'failed' ? 'warning' : status === 'error' ? 'error' : 'default'}>{labels[status] || status}</Tag> },
              { title: 'Reward', dataIndex: 'reward', render: (reward: number | null) => reward == null ? '—' : reward },
              { title: '完成时间', dataIndex: 'finished_at', render: date },
              { title: '说明', dataIndex: 'error', render: (value: string | undefined) => value || '—' },
            ]} />
          </>}
        </>}
      </Card>
    </Content>
    <Footer className="app-footer">{token.mode === 'local' ? '结果保存在浏览器，Harbor 在本机执行，临时文件完成后清理。' : '结果保存在当前云端账号；Harbor 原始产物保存在服务器账号目录。'}</Footer>
  </Layout>
}
