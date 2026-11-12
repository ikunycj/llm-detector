import { Context, type Locations, type LocationChoice } from './LocationContext'
import { useLocations } from './LocationContext'
export { useLocations } from './LocationContext'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Drawer, Modal, Radio, Tag, Typography } from 'antd'
import { CloudOutlined, DesktopOutlined } from '@ant-design/icons'
import { connectLocal, getUser, logout, request, type CloudSession } from '../api'
import { sourceID, sourceName, type APIClient, type SourceID } from '../data/sources'
import AccountCenter from '../features/auth/AccountCenter'
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
const saveLocationKey = 'llm-detector:save-location:v1'
export function SourceTag({ source }: { source?: SourceID }) {
  return <Tag color={source === 'cloud' ? 'blue' : 'default'}>{sourceName(source)}</Tag>
}

export function LocationsProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(restoreSession)
  const [saveLocation, setLocation] = useState<SourceID>(() =>
    session && localStorage.getItem(saveLocationKey) !== 'local' ? 'cloud' : 'local',
  )
  const [localToken, setLocalToken] = useState(() => localStorage.getItem('llm-detector:local-session') || '')
  const [choice, setChoice] = useState<LocationChoice>()
  const [selected, setSelected] = useState<SourceID>('local')
  const [accountOpen, setAccountOpen] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const pending = useRef<((value: APIClient | null) => void) | undefined>(undefined)
  const changed = useCallback(() => setRevision((value) => value + 1), [])
  const clearSession = useCallback(() => {
    localStorage.removeItem(sessionKey)
    localStorage.setItem(saveLocationKey, 'local')
    setSession(undefined)
    setLocation('local')
  }, [])
  useEffect(() => {
    if (!session) return
    const timeout = setTimeout(clearSession, Math.max(0, Date.parse(session.expires_at) - Date.now()))
    return () => clearTimeout(timeout)
  }, [session, clearSession])
  const localClient = useMemo<APIClient>(() => ({ mode: 'local', token: localToken }), [localToken])
  const clients = useMemo<APIClient[]>(() => [
    localClient,
    ...(session ? [{ mode: 'cloud' as const, token: session.token }] : []),
  ], [localClient, session])
  const owner = useCallback((source: SourceID = 'local') => {
    const client = clients.find((item) => item.mode === source)
    if (!client) throw new Error('请先登录云端账号')
    return client
  }, [clients])
  const connected = useCallback((token: string) => {
    localStorage.setItem('llm-detector:local-session', token)
    setLocalToken(token)
  }, [])
  const ensure = useCallback(async (client: APIClient, runner = false) => {
    if (client.mode === 'local' && runner) {
      if (client.token) {
        try {
          await request('/local/state', client, { signal: AbortSignal.timeout(3000) })
          return client
        } catch (err) {
          if (!(err instanceof Error)) throw err
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
        throw new Error('请先启动本机执行器，连接后重新点击保存或执行。')
      }
    }
    return client
  }, [connected])
  const unavailable = useCallback((client: APIClient, reason: unknown) => {
    if (client.mode === 'local' && client.token) {
      localStorage.removeItem('llm-detector:local-session')
      setLocalToken('')
      setError('本机执行器已断开，仍可查看浏览器数据；执行本机任务时重新连接。')
    }
    if (client.mode === 'cloud' && reason instanceof Error && 'status' in reason && reason.status === 401) {
      clearSession()
      setError('云端登录已过期，默认保存位置已切回本地。')
    }
  }, [clearSession])
  const choose = useCallback(async (next: LocationChoice) => {
    if (pending.current) throw new Error('请先完成当前的执行位置选择')
    if (next.action === 'save') {
      const client = owner(saveLocation)
      if (client.mode === 'cloud') {
        try { await getUser(client) }
        catch (err) { unavailable(client, err); throw err }
      }
      return ensure(client, next.requireRunner)
    }
    setChoice(next)
    setSelected(saveLocation)
    setError('')
    return new Promise<APIClient | null>((resolve) => { pending.current = resolve })
  }, [owner, saveLocation, ensure, unavailable])
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
        if (!session) { setAccountOpen(true); return }
        try { await getUser({ mode: 'cloud', token: session.token }) }
        catch (err) {
          if (err instanceof Error && 'status' in err && err.status === 401) {
            clearSession()
            setAccountOpen(true)
            return
          }
          throw err
        }
      }
      finish(await ensure(owner(selected), choice.requireRunner))
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接所选位置')
    } finally { setBusy(false) }
  }
  function setSaveLocation(source: SourceID) {
    if (source === 'cloud' && !session) { setAccountOpen(true); return }
    localStorage.setItem(saveLocationKey, source)
    setLocation(source)
  }
  async function signOut() {
    if (session) await logout({ mode: 'cloud', token: session.token })
    clearSession()
    setAccountOpen(false)
  }
  const value: Locations = {
    clients, session, saveLocation, setSaveLocation, choose, owner, ensure, unavailable,
    openAccount: () => setAccountOpen(true), openLocal: () => setLocalOpen(true),
    revision, changed, label: sourceName,
  }
  return <Context.Provider value={value}>
    {error && !choice && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
    {children}
    <Modal
      title={choice?.title || '选择执行位置'}
      open={Boolean(choice) && !accountOpen && !localOpen}
      zIndex={1100}
      onCancel={() => { if (!busy) finish(null) }}
      onOk={() => void confirm()}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      okText={selected === 'cloud' && !session ? '登录并继续' : '在此执行'}
      cancelText="取消"
    >
      <Radio.Group aria-label="选择执行位置" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy} className="destination-options">
        <Radio value="local"><DesktopOutlined /> 本地
          <Typography.Text type="secondary"> · 指纹在浏览器运行，其他任务使用本机执行器</Typography.Text>
        </Radio>
        <Radio value="cloud"><CloudOutlined /> 云端
          <Typography.Text type="secondary"> · {session ? session.user.username : '需要登录账号'}</Typography.Text>
        </Radio>
      </Radio.Group>
      {choice?.from && choice.from !== selected && <Alert
        className="destination-note" type="info" showIcon title="在所选位置执行并保存本次结果"
        description={`配置与执行所需的凭据会从${sourceName(choice.from)}发送到${sourceName(selected)}；密钥不显示在页面中。`}
      />}
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>
    <Modal title="个人中心" zIndex={1200} open={accountOpen} footer={null} destroyOnHidden onCancel={() => setAccountOpen(false)}>
      <AccountCenter session={session} saveLocation={saveLocation} onLogout={signOut} onOpenLocal={() => { setAccountOpen(false); setLocalOpen(true) }} onLogin={(saved) => {
        localStorage.setItem(sessionKey, JSON.stringify(saved))
        localStorage.setItem(saveLocationKey, 'cloud')
        setSession(saved)
        setLocation('cloud')
        setAccountOpen(false)
        setError('')
        changed()
        if (choice && selected === 'cloud') finish({ mode: 'cloud', token: saved.token })
      }} />
    </Modal>
    <Drawer title="本机执行器" zIndex={1200} open={localOpen} onClose={() => setLocalOpen(false)} size={640}>
      <LocalRuntime client={localClient} onConnected={connected} onDisconnected={() => {
        localStorage.removeItem('llm-detector:local-session')
        setLocalToken('')
      }} />
    </Drawer>
  </Context.Provider>
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
