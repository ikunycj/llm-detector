import type { APIClient } from '../../api'
import { SourceTag, useLocations } from '../../app/Locations'
import { CodeOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Radio,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd'
import { useCallback, useEffect, useState } from 'react'
import {
  connectionFor,
  installHarbor,
  createBenchJob,
  getCatalog,
  getBenchReadiness,
} from '../../api'
import ModelAPISelector, { modelServiceKey } from '../scans/ModelAPISelector'
import type { SavedModelService } from '../scans/savedServices'
import type { BenchCatalog, BenchReadiness } from './types'
import type { LogNavigation, LogTarget } from '../logs/records'

const { Content } = Layout
const { Text, Title, Paragraph } = Typography
const descriptions: Record<string, string> = {
  'regex-log': '从包含合法 IPv4 的日志行提取最后一个合法日期，检查字符边界和多日期情形。',
  'constraints-scheduling': '读取三人的 ICS 日历，综合可用时间、会议冲突、缓冲与偏好安排会议。',
  'cobol-modernization': '将 COBOL 交易程序迁移到 Python，保持连续交易和文件更新语义。',
  'cancel-async-tasks': '实现限并发异步执行器，并正确处理 SIGINT、已启动任务与排队任务清理。',
  'log-summary-date-ranges': '跨多个日期范围精确统计日志等级并输出 CSV，避免干扰文本误计数。',
  'db-wal-recovery': '从异常 SQLite 数据库及 WAL 恢复完整记录，验证更新、排序与去重。',
}
type FormValues = { model: string; suite: 'daily' | 'full'; concurrency: number }
export default function TerminalBenchPage({ onOpenLogs }: LogNavigation) {
  const [form] = Form.useForm<FormValues>()
  const suite = Form.useWatch('suite', form) || 'daily'
  const { choose, owner, changed } = useLocations()
  const [service, setService] = useState<SavedModelService>()
  const [catalog, setCatalog] = useState<BenchCatalog>()
  const [readiness, setReadiness] = useState<BenchReadiness>()
  const [checkedClient, setCheckedClient] = useState<APIClient>()
  const [checking, setChecking] = useState(false)
  const [submitted, setSubmitted] = useState<LogTarget>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const active = Boolean(busy)
  const serviceKey = modelServiceKey(service)
  const selectService = useCallback(
    (next: SavedModelService | undefined) => {
      setService(next)
      form.setFieldValue('model', next?.models[0] || '')
    },
    [form],
  )
  useEffect(() => {
    const controller = new AbortController()
    getCatalog(controller.signal)
      .then((data) => setCatalog(data.terminal_bench))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message)
      })
    return () => controller.abort()
  }, [])
  async function check() {
    setError('')
    try {
      const client = await choose({
        action: 'execute',
        title: '检查哪个位置的 Terminal Bench 环境？',
        from: service?.source,
        requireRunner: true,
      })
      if (!client) return
      setChecking(true)
      setCheckedClient(client)
      setReadiness(await getBenchReadiness(client))
    } catch (err) {
      setError(err instanceof Error ? err.message : '环境检查失败')
    } finally {
      setChecking(false)
    }
  }
  async function start(values: FormValues) {
    if (!service) return
    setError('')
    try {
      const client = await choose({
        action: 'execute',
        title: 'Terminal Bench 在哪里执行？',
        from: service.source,
        requireRunner: true,
      })
      if (!client) return
      setBusy('start')
      setCheckedClient(client)
      const state = await getBenchReadiness(client)
      setReadiness(state)
      if (!state.ready) throw new Error('所选位置的运行环境未就绪，请安装依赖后重试')
      const connection = await connectionFor(service, owner(service.source), client)
      const { vendor: _vendor, ...input } = connection
      const result = await createBenchJob(client, {
        ...input,
        model: values.model.trim(),
        suite: values.suite,
        concurrency: values.concurrency,
      })
      setSubmitted({ kind: 'bench', id: result.id, source: result.source })
      changed()
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败')
    } finally {
      setBusy('')
    }
  }
  const selectedNames = catalog ? (suite === 'daily' ? catalog.daily : catalog.tasks.map((task) => task.name)) : []
  return (
    <Layout className="engine-embedded-layout">
      <Content className="app-content terminal-bench-content">
        <div className="page-heading">
          <Title level={1}>
            <CodeOutlined /> Terminal Bench
          </Title>
          <Text type="secondary">直接选择首页模型 API，在本机或云端运行 Harbor / Terminus-2。</Text>
        </div>
        {error && <Alert type="error" title={error} showIcon closable onClose={() => setError('')} />}
        <Alert
          type="info"
          showIcon
          title="固定 Terminal-Bench 2.0 · 完整 89 题 / 日常 6 题"
          description="两套测试使用同一数据集提交和 Harbor 0.25.0。日常集适合固定配置的重复对比，不能替代完整测试集成绩；结果同时受模型、agent 与运行环境影响。"
        />
        <Card
          size="small"
          title={
            <Space>
              运行环境{' '}
              {checkedClient && (
                <SourceTag
                  source={checkedClient.mode === 'worker' ? `worker:${checkedClient.id}` : checkedClient.mode}
                />
              )}
            </Space>
          }
          extra={
            <Button icon={<ReloadOutlined />} loading={checking} onClick={() => void check()}>
              检查环境
            </Button>
          }
        >
          {readiness ? (
            <Space wrap>
              {readiness.checks.map((item) => (
                <Tag key={item.name} color={item.ready ? 'success' : 'error'}>
                  {item.name}：{item.detail}
                </Tag>
              ))}
            </Space>
          ) : (
            <Text type="secondary">
              首次运行前检查 Harbor、Docker 与 Docker Compose。可选依赖安装命令：
              <Text code>make terminal-bench-install</Text>
            </Text>
          )}
        </Card>
        {readiness && !readiness.ready && checkedClient && checkedClient.mode !== 'cloud' && (
          <Button
            onClick={() =>
              void installHarbor(checkedClient)
                .then(() => setError('依赖安装已开始，稍后请重新检查环境'))
                .catch((err) => setError(err.message))
            }
          >
            安装该 Worker 的 Python / Harbor
          </Button>
        )}
        <Row gutter={[20, 20]} className="terminal-bench-grid">
          <Col xs={24} lg={11}>
            <Card title="测试配置">
              <Space orientation="vertical" size={16} style={{ width: '100%' }}>
                <ModelAPISelector value={serviceKey} onChange={selectService} disabled={Boolean(busy) || active} />
                {service && (
                  <Space wrap>
                    <Tag>{service.name}</Tag>
                    <Tag>{service.protocol}</Tag>
                    <Text type="secondary">{service.base_url}</Text>
                  </Space>
                )}
                <Form
                  name="terminal-bench"
                  form={form}
                  layout="vertical"
                  requiredMark={false}
                  disabled={Boolean(busy) || active}
                  initialValues={{ suite: 'daily', concurrency: 1 }}
                  onFinish={start}
                >
                  <Form.Item
                    name="model"
                    label="模型 ID"
                    rules={[{ required: true, whitespace: true, message: '请输入模型 ID' }]}
                  >
                    {service?.models.length ? (
                      <Select
                        showSearch
                        allowClear
                        placeholder="选择首页配置中的模型"
                        options={service.models.map((model) => ({ value: model, label: model }))}
                      />
                    ) : (
                      <Input placeholder="首页配置未指定模型，请填写模型 ID" />
                    )}
                  </Form.Item>
                  <Form.Item name="suite" label="测试集">
                    <Radio.Group
                      optionType="button"
                      buttonStyle="solid"
                      options={[
                        { value: 'daily', label: '日常测试集 · 6 题' },
                        { value: 'full', label: '完整测试集 · 89 题' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    name="concurrency"
                    label="任务并发数"
                    extra="1–4，默认 1。每题只执行一次，不自动重试。"
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} max={4} precision={0} />
                  </Form.Item>
                  <Alert
                    type="warning"
                    showIcon
                    title="启动将执行任务代码、拉取 Docker 镜像并消耗模型额度。完整集可能耗时较长；本服务一次只运行一个批次。"
                  />
                  <Button
                    className="terminal-bench-start"
                    type="primary"
                    htmlType="submit"
                    block
                    icon={<PlayCircleOutlined />}
                    loading={busy === 'start'}
                    disabled={active || !service}
                  >
                    {active ? '已有测试运行中' : `开始${suite === 'daily' ? '日常 6 题' : '完整 89 题'}测试`}
                  </Button>
                </Form>
              </Space>
            </Card>
          </Col>
          <Col xs={24} lg={13}>
            <Card title={suite === 'daily' ? '日常测试集' : '完整测试集'} extra={<Tag>{selectedNames.length} 题</Tag>}>
              <List
                size="small"
                className="terminal-bench-task-catalog"
                dataSource={selectedNames}
                renderItem={(name) => (
                  <List.Item>
                    <Space orientation="vertical" size={2}>
                      <Text strong>{name}</Text>
                      {descriptions[name] && <Text type="secondary">{descriptions[name]}</Text>}
                    </Space>
                  </List.Item>
                )}
              />
              <Paragraph type="secondary" className="terminal-bench-source">
                源码固定为 <Text code>{catalog?.tasks[0]?.git_commit_id.slice(0, 12)}</Text>
                ；完整题单来自官方注册表。不会跟随上游 main 自动替换题目。
              </Paragraph>
            </Card>
          </Col>
        </Row>
        {submitted && <Alert type="success" showIcon title="Terminal Bench 已启动" description="逐题进度与运行结果已加入巡检日志。" action={<Button onClick={() => onOpenLogs(submitted)}>查看巡检日志</Button>} />}
      </Content>
    </Layout>
  )
}
