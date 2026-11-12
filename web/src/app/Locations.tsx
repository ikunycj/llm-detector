import { Context, useLocations, type Locations, type LocationChoice } from './LocationContext'
export { useLocations } from './LocationContext'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Drawer, Empty, Form, Input, List, Modal, Radio, Select, Space, Tag, Typography } from 'antd'
import { CloudOutlined, DesktopOutlined, PlusOutlined, ApiOutlined, DeleteOutlined } from '@ant-design/icons'
import { checkWorker, connectLocal, getUser, logout, request, type CloudSession } from '../api'
import {
  readWorkers,
  parseWorker,
  sourceID,
  sourceName,
  workerClient,
  writeWorkers,
  type APIClient,
  type SourceID,
  type WorkerConfig,
} from '../data/sources'
import Login from '../features/auth/Login'
import LocalRuntime from './LocalRuntime'

const sessionKey = 'llm-detector:cloud-session:v1'
function restoreSession(): CloudSession | undefined {
  const raw = localStorage.getItem(sessionKey)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    if (
      typeof value.token === 'string' &&
      value.token &&
      typeof value.user?.id === 'number' &&
      typeof value.user?.username === 'string' &&
      Number.isFinite(Date.parse(value.expires_at)) &&
      Date.parse(value.expires_at) > Date.now()
    )
      return value
  } catch {
    /* Invalid browser session is discarded; it is never sent to a server. */
  }
  localStorage.removeItem(sessionKey)
}
export function SourceTag({ source }: { source?: SourceID }) {
  const { label } = useLocations()
  return (
    <Tag color={source === 'cloud' ? 'blue' : source?.startsWith('worker:') ? 'purple' : 'default'}>
      {label(source)}
    </Tag>
  )
}

export function LocationsProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(restoreSession)
  const [workers, setWorkers] = useState<WorkerConfig[]>([])
  const [localToken, setLocalToken] = useState(() => localStorage.getItem('llm-detector:local-session') || '')
  const [choice, setChoice] = useState<LocationChoice>()
  const [selected, setSelected] = useState<SourceID>('local')
  const [loginOpen, setLoginOpen] = useState(false)
  const [workersOpen, setWorkersOpen] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [error, setError] = useState('')
  const [workerError, setWorkerError] = useState('')
  const [busy, setBusy] = useState(false)
  const [workerBusy, setWorkerBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [workerForm] = Form.useForm<{ name: string; url: string; key: string }>()
  const [platform, setPlatform] = useState('darwin')
  const [arch, setArch] = useState('arm64')
  const pending = useRef<((value: APIClient | null) => void) | undefined>(undefined)
  const [editing, setEditing] = useState<string>()
  const changed = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    try {
      setWorkers(readWorkers())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Worker 配置读取失败')
    }
  }, [])
  useEffect(() => {
    if (!session) return
    const timeout = setTimeout(
      () => {
        localStorage.removeItem(sessionKey)
        setSession(undefined)
      },
      Math.max(0, Date.parse(session.expires_at) - Date.now()),
    )
    return () => clearTimeout(timeout)
  }, [session])
  const localClient = useMemo<APIClient>(() => ({ mode: 'local', token: localToken }), [localToken])
  const clients = useMemo(
    () => [
      localClient,
      ...(session ? [{ mode: 'cloud' as const, token: session.token }] : []),
      ...workers.map(workerClient),
    ],
    [localClient, session, workers],
  )
  const owner = useCallback(
    (source: SourceID = 'local') => {
      const client = clients.find((item) => sourceID(item) === source)
      if (!client) throw new Error('数据来源未连接，请先登录云端或配置对应 Worker')
      return client
    },
    [clients],
  )
  const connected = useCallback((token: string) => {
    localStorage.setItem('llm-detector:local-session', token)
    setLocalToken(token)
  }, [])
  const ensure = useCallback(
    async (client: APIClient, runner = false) => {
      if (client.mode === 'local' && runner) {
        if (client.token) {
          try {
            await request('/local/state', client, { signal: AbortSignal.timeout(3000) })
            return client
          } catch (err) {
            if (!(err instanceof Error)) throw err
            // A local runner restart invalidates its in-memory session. Reconnect using browser state.
            localStorage.removeItem('llm-detector:local-session')
            setLocalToken('')
          }
        }
        try {
          const result = await connectLocal()
          connected(result.token)
          return { mode: 'local', token: result.token } as APIClient
        } catch {
          setLocalOpen(true)
          throw new Error('请先启动本机 Worker，连接后重新点击保存或执行。')
        }
      }
      if (client.mode === 'worker') await checkWorker(client)
      return client
    },
    [connected],
  )
  const choose = useCallback((next: LocationChoice) => {
    if (pending.current) return Promise.reject(new Error('请先完成当前的位置选择'))
    setChoice(next)
    setSelected(next.from || 'local')
    setError('')
    return new Promise<APIClient | null>((resolve) => {
      pending.current = resolve
    })
  }, [])
  function finish(client: APIClient | null) {
    const resolve = pending.current
    pending.current = undefined
    setChoice(undefined)
    resolve?.(client)
  }
  async function confirm() {
    if (!choice) return
    setError('')
    setBusy(true)
    try {
      if (selected === 'cloud') {
        if (!session) {
          setLoginOpen(true)
          return
        }
        try {
          await getUser({ mode: 'cloud', token: session.token })
        } catch (err) {
          if (err instanceof Error && 'status' in err && err.status === 401) {
            localStorage.removeItem(sessionKey)
            setSession(undefined)
            setLoginOpen(true)
            return
          }
          throw err
        }
      }
      const client = await ensure(owner(selected), choice.requireRunner)
      if (client) finish(client)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接所选位置')
    } finally {
      setBusy(false)
    }
  }
  async function saveWorker(values: { name: string; url: string; key: string }) {
    setWorkerBusy(true)
    setWorkerError('')
    try {
      const next = parseWorker({ ...values, name: values.name || values.url, id: editing || crypto.randomUUID() })
      await checkWorker(workerClient(next))
      const updated = [...workers.filter((item) => item.id !== next.id), next]
      writeWorkers(updated)
      setWorkers(updated)
      setSelected(`worker:${next.id}`)
      setEditing(undefined)
      workerForm.resetFields()
      setWorkersOpen(false)
      changed()
    } catch (err) {
      setWorkerError(err instanceof Error ? err.message : 'Worker 连接失败')
    } finally {
      setWorkerBusy(false)
    }
  }
  async function signOut() {
    if (session) await logout({ mode: 'cloud', token: session.token })
    localStorage.removeItem(sessionKey)
    setSession(undefined)
  }
  const unavailable = useCallback((client: APIClient, reason: unknown) => {
    if (client.mode === 'local' && client.token) {
      localStorage.removeItem('llm-detector:local-session')
      setLocalToken('')
      setError('本机 Worker 已断开，仍可查看浏览器数据；执行本机任务时重新连接。')
    }
    if (client.mode === 'cloud' && reason instanceof Error && 'status' in reason && reason.status === 401) {
      localStorage.removeItem(sessionKey)
      setSession(undefined)
      setError('云端登录已过期。浏览器与 Worker 数据继续可用。')
    }
  }, [])
  const value: Locations = {
    clients,
    session,
    choose,
    owner,
    ensure,
    unavailable,
    openWorkers: () => setWorkersOpen(true),
    openLocal: () => setLocalOpen(true),
    signIn: () => setLoginOpen(true),
    signOut,
    revision,
    changed,
    label: (source) => sourceName(source, clients),
  }
  const origin = window.location.origin
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
  const installCommand = `curl -fsSL ${quote(origin + '/downloads/install-worker.sh')} -o install-worker.sh && sh install-worker.sh ${quote(origin)}`
  return (
    <Context.Provider value={value}>
      {error && !choice && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
      {children}
      <Modal
        title={choice?.title || '选择位置'}
        open={Boolean(choice) && !workersOpen && !installOpen && !loginOpen && !localOpen}
        zIndex={1100}
        onCancel={() => {
          if (!busy) finish(null)
        }}
        onOk={() => void confirm()}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        okText={
          selected === 'cloud' && !session ? '登录并继续' : choice?.action === 'save' ? '保存到此位置' : '在此执行'
        }
        cancelText="取消"
      >
        <Radio.Group
          aria-label="选择保存或执行位置"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={busy}
          className="destination-options"
        >
          <Radio value="local">
            <DesktopOutlined /> {choice?.action === 'save' ? '浏览器本地' : '本地'}
            <Typography.Text type="secondary">
              {choice?.action === 'execute' ? ' · 指纹在浏览器运行，其他任务使用本机 Worker' : ' · 仅保存在这台浏览器'}
            </Typography.Text>
          </Radio>
          <Radio value="cloud">
            <CloudOutlined /> 云端
            <Typography.Text type="secondary">
              {session ? ` · ${session.user.username}` : ' · 需要访问密钥'}
            </Typography.Text>
          </Radio>
          {workers.map((worker) => (
            <Radio key={worker.id} value={`worker:${worker.id}`}>
              <ApiOutlined /> {worker.name}
              <Typography.Text type="secondary"> · 自建 Worker</Typography.Text>
            </Radio>
          ))}
        </Radio.Group>
        <Button type="dashed" icon={<PlusOutlined />} block onClick={() => setWorkersOpen(true)} disabled={busy}>
          自建worker
        </Button>
        {choice?.from && choice.from !== selected && (
          <Alert
            className="destination-note"
            type="info"
            showIcon
            title={choice.action === 'save' ? '将在所选位置创建副本，原数据保留' : '在所选位置执行并保存本次结果'}
            description={`配置与执行所需的凭据会从${sourceName(choice.from, clients)}发送到${sourceName(selected, clients)}；密钥不显示在页面中。`}
          />
        )}
        {error && <Alert type="error" showIcon title={error} />}
      </Modal>
      <Modal title="登录云端" zIndex={1200} open={loginOpen} footer={null} destroyOnHidden onCancel={() => setLoginOpen(false)}>
        <Login
          onLogin={(token, user, expires_at) => {
            const saved = { token, user, expires_at }
            localStorage.setItem(sessionKey, JSON.stringify(saved))
            setSession(saved)
            setLoginOpen(false)
            setError('')
            changed()
            if (choice && selected === 'cloud') finish({ mode: 'cloud', token })
          }}
        />
      </Modal>
      <Drawer title="自建worker" zIndex={1200} open={workersOpen} onClose={() => setWorkersOpen(false)} size={580}>
        <Typography.Paragraph type="secondary">
          连接已有的 LLM Detector Worker。配置与访问密钥只保存在当前浏览器。
        </Typography.Paragraph>
        <Form name="worker-connection" form={workerForm} layout="vertical" onFinish={saveWorker} disabled={workerBusy}>
          <Form.Item name="name" label="名称（可选）">
            <Input placeholder="例如：我的服务器" />
          </Form.Item>
          <Form.Item name="url" label="Worker 地址" rules={[{ required: true, message: '请输入 Worker 地址' }]}>
            <Input placeholder="https://worker.example.com" />
          </Form.Item>
          <Form.Item name="key" label="密钥" rules={[{ required: true, message: '请输入 Worker 密钥' }]}>
            <Input.Password autoComplete="off" placeholder="worker.env 中的 WORKER_KEY" />
          </Form.Item>
          {workerError && <Alert type="error" showIcon title={workerError} />}
          <Button type="primary" htmlType="submit" loading={workerBusy}>
            保存并连接
          </Button>
        </Form>
        <Space className="worker-install-links">
          <Button
            type="link"
            size="small"
            onClick={() => {
              setPlatform('darwin')
              setInstallOpen(true)
            }}
          >
            本机安装worker
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setPlatform('linux')
              setInstallOpen(true)
            }}
          >
            服务器安装worker
          </Button>
        </Space>
        <List
          header="已保存的 Worker"
          locale={{ emptyText: <Empty description="尚未添加 Worker" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          dataSource={workers}
          renderItem={(worker) => (
            <List.Item
              actions={[
                <Button
                  key="edit"
                  type="link"
                  onClick={() => {
                    setEditing(worker.id)
                    workerForm.setFieldsValue({ ...worker, key: worker.key })
                  }}
                >
                  编辑
                </Button>,
                <Button
                  key="delete"
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label={`移除 Worker ${worker.name}`}
                  onClick={() => {
                    const next = workers.filter((item) => item.id !== worker.id)
                    writeWorkers(next)
                    setWorkers(next)
                    changed()
                  }}
                />,
              ]}
            >
              <List.Item.Meta title={worker.name} description={worker.url} />
            </List.Item>
          )}
        />
        <Typography.Text type="secondary">移除连接只影响本浏览器，Worker 上的数据保留。</Typography.Text>
      </Drawer>
      <Drawer
        title={platform === 'linux' ? '服务器安装 Worker' : '本机安装 Worker'}
        open={installOpen}
        zIndex={1300}
        onClose={() => setInstallOpen(false)}
        size={640}
      >
        <Typography.Paragraph>
          下载后解压，双击 start 文件。首次运行自动生成 worker.env，填入文件内的 WORKER_KEY 即可连接。
        </Typography.Paragraph>
        <Space wrap>
          <Select
            aria-label="Worker 操作系统"
            value={platform}
            onChange={setPlatform}
            options={[
              { value: 'darwin', label: 'macOS' },
              { value: 'windows', label: 'Windows' },
              { value: 'linux', label: 'Linux' },
            ]}
          />
          <Select
            aria-label="Worker 架构"
            value={arch}
            onChange={setArch}
            options={[
              { value: 'arm64', label: 'ARM64 / Apple Silicon' },
              { value: 'amd64', label: 'x64 / Intel / AMD' },
            ]}
          />
          <Button href={`/downloads/llm-detector-worker-${platform}-${arch}.zip`} download>
            下载 Worker
          </Button>
        </Space>
        <Typography.Paragraph className="destination-note">
          本机默认地址：<Typography.Text code>http://127.0.0.1:9003</Typography.Text>。在 worker.env 的 WORKER_ORIGINS
          中加入当前页面来源：
          <Typography.Text copyable code>
            {origin}
          </Typography.Text>
        </Typography.Paragraph>
        {platform === 'linux' && (
          <>
            <Typography.Title level={5}>Linux 服务器一条命令安装</Typography.Title>
            <Typography.Paragraph>
              在服务器终端执行；安装到当前用户目录并在后台启动。再次执行会保留数据和密钥。若本页是
              localhost，请改用部署后的页面地址，或上传 Linux 压缩包运行 start.sh。
            </Typography.Paragraph>
            <Typography.Paragraph code copyable>
              {installCommand}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary">
              默认监听 9003。为浏览器访问配置 HTTPS 反向代理后，将完整 HTTPS 地址填入 Worker 配置。Docker 与 Git
              需安装；Terminal Bench 的 Python / Harbor 可通过“检查环境”后的按钮安装。
            </Typography.Paragraph>
          </>
        )}
      </Drawer>
      <Drawer title="本机 Worker" zIndex={1200} open={localOpen} onClose={() => setLocalOpen(false)} size={640}>
        <LocalRuntime
          client={localClient}
          onConnected={connected}
          onDisconnected={() => {
            localStorage.removeItem('llm-detector:local-session')
            setLocalToken('')
          }}
        />
      </Drawer>
    </Context.Provider>
  )
}

export function useSourceData<T>(load: (client: APIClient, signal: AbortSignal) => Promise<T[]>, pollMs = 0) {
  const { clients, revision, label, unavailable } = useLocations()
  const [items, setItems] = useState<T[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      const results = await Promise.allSettled(clients.map((client) => load(client, controller.signal)))
      if (controller.signal.aborted) return
      const next: T[] = []
      const failures: string[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') next.push(...result.value)
        else {
          failures.push(
            `${label(sourceID(clients[index]))}：${result.reason instanceof Error ? result.reason.message : '读取失败'}`,
          )
          unavailable(clients[index], result.reason)
        }
      })
      setItems(next)
      setErrors(failures)
      setLoading(false)
      if (pollMs) timer = setTimeout(refresh, pollMs)
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [clients, load, pollMs, revision, version])
  return { items, errors, loading, refresh: () => setVersion((value) => value + 1), setItems }
}
