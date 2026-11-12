import { CodeOutlined, RadarChartOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Layout, Menu, Segmented, Skeleton, Space, Typography } from 'antd'
import { type ReactElement, useEffect, useState } from 'react'
import { getCatalog } from '../../api'
import type { AppPage, Evaluator } from '../../types'
import type { LogNavigation } from '../logs/records'
import FingerprintPage from '../fingerprint/FingerprintPage'
import TerminalBenchPage from '../terminalbench/TerminalBenchPage'

const { Content, Sider } = Layout
const { Text } = Typography

type Props = LogNavigation & {
  onNavigate: (page: AppPage) => void
}

// Only specialized renderers live here; IDs, labels and available engines come from the API.
const engineViews: Record<
  string,
  {
    icon: ReactElement
    render: (props: LogNavigation) => ReactElement
  }
> = {
  fingerprint: { icon: <RadarChartOutlined />, render: (props) => <FingerprintPage {...props} /> },
  'terminal-bench': { icon: <CodeOutlined />, render: (props) => <TerminalBenchPage {...props} /> },
}
export default function EnginesPage({ onNavigate, onOpenLogs }: Props) {
  const [engine, setEngine] = useState('')
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    getCatalog(controller.signal)
      .then(({ evaluators }) => {
        if (controller.signal.aborted) return
        setEngines(evaluators)
        setEngine((current) => (evaluators.some((item) => item.id === current) ? current : evaluators[0]?.id || ''))
        setLoaded(true)
        setError('')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : '无法加载巡检引擎')
      })
    return () => controller.abort()
  }, [revision])

  const engineItems = engines.map((item) => ({
    key: item.id,
    label: item.name,
    icon: engineViews[item.id]?.icon || <ThunderboltOutlined />,
  }))
  const selectedEngine = engines.find((item) => item.id === engine)

  return (
    <Layout className="app-layout">
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
            <Segmented
              aria-label="切换巡检引擎"
              value={engine}
              onChange={setEngine}
              options={engineItems.map((item) => ({ value: item.key, label: item.label, icon: item.icon }))}
            />
          </div>
          {error && (
            <Alert
              className="engine-shell-error"
              type="error"
              title={error}
              showIcon
              action={
                <Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>
                  重试
                </Button>
              }
            />
          )}
          {!loaded && !error && <Skeleton active />}
          {loaded && !engines.length && <Empty description="当前没有注册巡检引擎" />}
          {selectedEngine &&
            (engineViews[selectedEngine.id]?.render({ onOpenLogs }) || (
              <Card title={selectedEngine.name}>
                <Space orientation="vertical">
                  <Text>{selectedEngine.description}</Text>
                  <Button type="primary" onClick={() => onNavigate('scan')}>
                    前往首页
                  </Button>
                </Space>
              </Card>
            ))}
        </Content>
      </Layout>
    </Layout>
  )
}
