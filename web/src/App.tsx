import { UserOutlined } from '@ant-design/icons'
import { Button, Layout, Segmented, Space, Typography } from 'antd'
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
  const [logTarget, setLogTarget] = useState<LogTarget>()
  function openLogs(target?: LogTarget) { setLogTarget(target); setPage('logs') }
  const { session, saveLocation, setSaveLocation, openAccount } = useLocations()
  return (
    <Layout className="app-layout">
      <Layout.Header className="app-header unified-header">
        <Space className="brand">
          <img className="brand-logo" src="/llm-detector-logo.png" alt="LLM Detector 机器人标志" />
          <Typography.Text strong>LLM Detector</Typography.Text>
        </Space>
        <div className="header-center">
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
        <div className="save-location-control">
          <Typography.Text type="secondary">数据默认保存位置</Typography.Text>
          <Segmented
            aria-label="数据默认保存位置"
            value={saveLocation}
            onChange={setSaveLocation}
            options={[{ label: '本地', value: 'local' }, { label: '云端', value: 'cloud' }]}
          />
        </div>
        </div>
        <Button icon={<UserOutlined />} onClick={openAccount} aria-label="个人中心">
          {session ? `${session.user.username} · 个人中心` : '个人中心'}
        </Button>
      </Layout.Header>
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
