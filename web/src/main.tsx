import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Button, ConfigProvider, Result, Space } from 'antd'
import App from './App'
import 'antd/dist/reset.css'
import './styles.css'

type BoundaryState = { error: Error | null }
class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }
  static getDerivedStateFromError(error: Error): BoundaryState { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('LLM Detector 页面渲染失败', error, info) }
  render() {
    if (!this.state.error) return this.props.children
    return <Result status="error" title="页面渲染失败" subTitle="页面出现渲染错误。请刷新重试；浏览器、云端和 Worker 中的已保存数据不会因刷新而删除。" extra={<Space orientation="vertical" align="center"><Button type="primary" onClick={() => window.location.reload()}>刷新页面</Button><Alert type="error" showIcon message={this.state.error.message || '未知渲染错误'} /></Space>} />
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#4359d7',
          colorInfo: '#4359d7',
          borderRadius: 8,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        },
        components: {
          Layout: { headerBg: '#ffffff', bodyBg: '#f6f8fc' },
          Card: { borderRadiusLG: 12 },
        },
      }}
    >
      <AppErrorBoundary><App /></AppErrorBoundary>
    </ConfigProvider>
  </StrictMode>,
)
