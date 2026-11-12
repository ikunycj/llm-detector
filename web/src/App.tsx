import { ApiOutlined, CloudOutlined, DesktopOutlined, LogoutOutlined } from '@ant-design/icons'
import { Alert, Button, Layout, Segmented, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { LocationsProvider, useLocations } from './app/Locations'
import Workbench from './features/scans/Workbench'
import EnginesPage from './features/engines/EnginesPage'
import InspectionPage from './features/inspection/InspectionPage'
import type { AppPage } from './types'
import LogsPage from './features/logs/LogsPage'
import type { LogTarget } from './features/logs/records'
export default function App() {
  return (
    <LocationsProvider>
      <Workspace />
    </LocationsProvider>
  )
}
function Workspace() {
  const [page, setPage] = useState<AppPage>('scan')
  const [error, setError] = useState('')
  const [logTarget, setLogTarget] = useState<LogTarget>()
  function openLogs(target?: LogTarget) { setLogTarget(target); setPage('logs') }
  const { session, signIn, signOut, openWorkers, openLocal } = useLocations()
  return (
    <Layout className="app-layout">
      <Layout.Header className="app-header unified-header">
        <Space className="brand">
          <span className="brand-mark">L</span>
          <Typography.Text strong>LLM Detector</Typography.Text>
        </Space>
        <Segmented
          aria-label="主导航"
          value={page}
          onChange={(value) => { setLogTarget(undefined); setPage(value as AppPage) }}
          options={[
            { label: '首页', value: 'scan' },
            { label: '项目巡检', value: 'tasks' },
            { label: '巡检引擎', value: 'engines' },
            { label: '巡检日志', value: 'logs' },
          ]}
        />
        <Space wrap>
          <Button icon={<DesktopOutlined />} onClick={openLocal}>
            本机 Worker
          </Button>
          <Button icon={<ApiOutlined />} onClick={openWorkers}>
            自建worker
          </Button>
          {session ? (
            <>
              <Tag color="blue">{session.user.username}</Tag>
              <Button
                type="text"
                icon={<LogoutOutlined />}
                onClick={() => void signOut().catch((err) => setError(err.message))}
              >
                退出
              </Button>
            </>
          ) : (
            <Button icon={<CloudOutlined />} onClick={signIn}>
              登录云端
            </Button>
          )}
        </Space>
      </Layout.Header>
      {error && <Alert type="error" title={error} closable onClose={() => setError('')} />}
      <div className="workspace-surface">
        {page === 'tasks' ? (
          <InspectionPage onOpenLogs={openLogs} />
        ) : page === 'engines' ? (
          <EnginesPage onNavigate={setPage} onOpenLogs={openLogs} />
        ) : page === 'logs' ? (
          <LogsPage initialTarget={logTarget} />
        ) : (
          <Workbench onOpenLogs={openLogs} />
        )}
      </div>
    </Layout>
  )
}
