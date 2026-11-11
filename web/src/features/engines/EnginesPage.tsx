import type { APIClient, ExecutionLocation } from '../../api'
import { CodeOutlined, LogoutOutlined, RadarChartOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Layout, Menu, Segmented, Skeleton, Space, Typography } from 'antd'
import { type ReactElement, useEffect, useState } from 'react'
import { ApiError, getEvaluators, logout } from '../../api'
import type { AppPage, Evaluator } from '../../types'
import FingerprintPage from '../fingerprint/FingerprintPage'
import TerminalBenchPage from '../terminalbench/TerminalBenchPage'

const { Content, Header, Sider } = Layout
const { Text } = Typography

type Props = {
  token: APIClient
  localClient: APIClient
  cloudClient: APIClient
  onExpired: (location?: ExecutionLocation) => void
  onLogout: () => void
  onNavigate: (page: AppPage) => void
}

// Only specialized renderers live here; IDs, labels and available engines come from the API.
const engineViews: Record<string, {
  icon: ReactElement
  render: (props: Pick<Props, 'token' | 'localClient' | 'cloudClient' | 'onExpired'>) => ReactElement
}> = {
  fingerprint: { icon: <RadarChartOutlined />, render: (props) => <FingerprintPage {...props} /> },
  'terminal-bench': { icon: <CodeOutlined />, render: (props) => <TerminalBenchPage {...props} /> },
}
const navigation = [
  { label: '首页', value: 'scan' },
  { label: '巡检任务', value: 'tasks' },
  { label: '巡检引擎', value: 'engines' },
]

export default function EnginesPage({ token, localClient, cloudClient, onExpired, onLogout, onNavigate }: Props) {
  const [engine, setEngine] = useState('')
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    getEvaluators(token, controller.signal).then(({ evaluators }) => {
      if (controller.signal.aborted) return
      setEngines(evaluators)
      setEngine((current) => evaluators.some((item) => item.id === current) ? current : evaluators[0]?.id || '')
      setLoaded(true)
      setError('')
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return
      if (err instanceof ApiError && err.status === 401) onExpired()
      else setError(err instanceof Error ? err.message : '无法加载巡检引擎')
    })
    return () => controller.abort()
  }, [token, onExpired, revision])

  const engineItems = engines.map((item) => ({ key: item.id, label: item.name, icon: engineViews[item.id]?.icon || <ThunderboltOutlined /> }))
  const selectedEngine = engines.find((item) => item.id === engine)

  async function signOut() {
    setSigningOut(true); setError('')
    try { await logout(token); onLogout() }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) onExpired()
      else setError(err instanceof Error ? err.message : '退出登录失败，请重试')
    } finally { setSigningOut(false) }
  }

  return <Layout className="app-layout">

    <Layout className="engine-layout">
      <Sider className="engine-sider" width={220} breakpoint="md" collapsedWidth={0} trigger={null} theme="light">
        <div className="engine-sider-heading">
          <Text strong>巡检引擎</Text>
          <Text type="secondary">选择检测方式</Text>
        </div>
        <nav aria-label="巡检引擎">
          <Menu mode="inline" selectedKeys={[engine]} items={engineItems} onClick={({ key }) => setEngine(key)} />
        </nav>
      </Sider>
      <Content className="engine-content">
        <div className="engine-mobile-switcher">
          <Text strong>巡检引擎</Text>
          <Segmented aria-label="切换巡检引擎" value={engine} onChange={setEngine} options={engineItems.map((item) => ({ value: item.key, label: item.label, icon: item.icon }))} />
        </div>
        {error && <Alert className="engine-shell-error" type="error" title={error} showIcon action={<Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>重试</Button>} />}
        {!loaded && !error && <Skeleton active />}
        {loaded && !engines.length && <Empty description="当前没有注册巡检引擎" />}
        {selectedEngine && (engineViews[selectedEngine.id]?.render({ token, localClient, cloudClient, onExpired }) || <Card title={selectedEngine.name}>
          <Space orientation="vertical"><Text>{selectedEngine.description}</Text><Button type="primary" onClick={() => onNavigate('scan')}>前往首页</Button></Space>
        </Card>)}
      </Content>
    </Layout>
  </Layout>
}
