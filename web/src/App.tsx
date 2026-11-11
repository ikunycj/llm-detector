import { CloudOutlined, DesktopOutlined, LogoutOutlined } from '@ant-design/icons'
import { Alert, Button, Drawer, Layout, Modal, Segmented, Space, Tag, Typography } from 'antd'
import { useCallback, useMemo, useState } from 'react'
import { getUser, logout, type APIClient, type User } from './api'
import Login from './features/auth/Login'
import Workbench from './features/scans/Workbench'
import EnginesPage from './features/engines/EnginesPage'
import InspectionPage from './features/inspection/InspectionPage'
import LocalRuntime from './app/LocalRuntime'
import type { AppPage } from './types'

const cloudSessionKey = 'llm-detector:cloud-session:v1'
type CloudSession = { token: string; user: User; expires_at: string }

function readCloudSession(): CloudSession | undefined {
  const raw = localStorage.getItem(cloudSessionKey)
  if (!raw) return undefined
  try {
    const session = JSON.parse(raw) as Partial<CloudSession>
    if (typeof session.token !== 'string' || !session.token || !session.user || typeof session.expires_at !== 'string' || Date.parse(session.expires_at) <= Date.now()) {
      localStorage.removeItem(cloudSessionKey)
      return undefined
    }
    return session as CloudSession
  } catch {
    localStorage.removeItem(cloudSessionKey)
    return undefined
  }
}

function storeCloudSession(session: CloudSession) {
  localStorage.setItem(cloudSessionKey, JSON.stringify(session))
}
function clearCloudSession() {
  localStorage.removeItem(cloudSessionKey)
}

export default function App() {
  const initialCloud = useMemo(readCloudSession, [])
  const [mode, setMode] = useState<'local' | 'cloud'>('local')
  const [cloudToken, setCloudToken] = useState(initialCloud?.token || '')
  const [localToken, setLocalToken] = useState(() => localStorage.getItem('llm-detector:local-session') || '')
  const [user, setUser] = useState<User | undefined>(initialCloud?.user)
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<AppPage>('scan')
  const [loginOpen, setLoginOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const workspaceClient = useMemo<APIClient>(() => ({ mode, token: mode === 'local' ? localToken : cloudToken }), [mode, localToken, cloudToken])
  const localClient = useMemo<APIClient>(() => ({ mode: 'local', token: localToken }), [localToken])
  const cloudClient = useMemo<APIClient>(() => ({ mode: 'cloud', token: cloudToken }), [cloudToken])

  const clearCloud = useCallback(() => {
    clearCloudSession()
    setCloudToken('')
    setUser(undefined)
  }, [])
  const expired = useCallback(() => {
    if (mode === 'local') {
      localStorage.removeItem('llm-detector:local-session')
      setLocalToken('')
      setNotice('本机执行器连接已失效，请重新连接。')
      setRuntimeOpen(true)
    } else {
      clearCloud()
      setMode('local')
      setNotice('云端登录已失效，已返回本地。')
      setLoginOpen(true)
    }
  }, [clearCloud, mode])

  async function selectMode(next: string | number) {
    if (next === 'local') { setMode('local'); setNotice(''); return }
    if (cloudToken) {
      setBusy(true)
      try {
        const account = await getUser(cloudClient)
        setUser(account)
        const stored = readCloudSession()
        if (stored) storeCloudSession({ ...stored, user: account })
        setMode('cloud')
        setNotice('云端个人配置已合并到当前浏览器视图。')
      } catch {
        clearCloud()
        setLoginOpen(true)
      } finally { setBusy(false) }
    } else setLoginOpen(true)
  }

  async function signOut() {
    setBusy(true)
    try {
      if (cloudToken) await logout(cloudClient)
      clearCloud()
      setMode('local')
      setNotice('已退出云端，当前回到本地模式。')
    } catch { setNotice('退出云端失败，请重试') }
    finally { setBusy(false) }
  }

  const props = {
    token: workspaceClient,
    localClient,
    cloudClient,
    onExpired: expired,
    onLogout: () => void signOut(),
    onNavigate: setPage,
  }
  return <Layout className="app-layout">
    <Layout.Header className="app-header mode-header">
      <Space className="brand"><span className="brand-mark">L</span><Typography.Text strong>LLM Detector</Typography.Text></Space>
      <Segmented aria-label="数据工作区" value={mode} disabled={busy} onChange={selectMode} options={[{ value: 'local', label: '本地', icon: <DesktopOutlined /> }, { value: 'cloud', label: '云端', icon: <CloudOutlined /> }]} />
      <Space wrap className="mode-navigation"><Segmented aria-label="主导航" value={page} onChange={(value) => setPage(value as AppPage)} options={[{ label: '首页', value: 'scan' }, { label: '巡检任务', value: 'tasks' }, { label: '巡检引擎', value: 'engines' }]} />
        {mode === 'cloud' ? <><Tag color="blue">{user?.username}</Tag><Button type="text" icon={<LogoutOutlined />} loading={busy} onClick={() => void signOut()}>退出</Button></> : <Button onClick={() => setRuntimeOpen(true)}>{localToken ? '本机已连接' : '下载 / 连接执行器'}</Button>}
      </Space>
    </Layout.Header>
    {notice && <Alert showIcon title={notice} type="info" closable onClose={() => setNotice('')} />}
    {mode === 'local' && !localToken && <Alert className="runtime-banner" type="info" title="当前为本地模式，无需登录" description="浏览器配置与历史保存在本机。Fingerpoint 可直接在浏览器运行；Terminal Bench 需要连接本机执行器。" action={<Button onClick={() => setRuntimeOpen(true)}>准备本机环境</Button>} showIcon />}
    <div className="workspace-surface">{page === 'tasks' ? <InspectionPage {...props} /> : page === 'engines' ? <EnginesPage {...props} /> : <Workbench {...props} />}</div>
    <Modal title="登录云端" open={loginOpen} footer={null} destroyOnHidden onCancel={() => setLoginOpen(false)}><Login onLogin={(token, account, expires_at) => {
      const session = { token, user: account, expires_at }
      storeCloudSession(session)
      setCloudToken(token); setUser(account); setMode('cloud'); setNotice('云端个人配置已合并到当前浏览器视图。'); setLoginOpen(false)
    }} /></Modal>
    <Drawer title="本机执行环境" open={runtimeOpen} onClose={() => setRuntimeOpen(false)} size={640}><LocalRuntime client={localClient} onConnected={(token) => { localStorage.setItem('llm-detector:local-session', token); setLocalToken(token); setNotice('本机执行器已连接。') }} onDisconnected={() => { localStorage.removeItem('llm-detector:local-session'); setLocalToken(''); setNotice('已断开本机执行器。') }} /></Drawer>
  </Layout>
}
