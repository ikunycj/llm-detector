import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import App from './App'
import 'antd/dist/reset.css'
import './styles.css'

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
      <App />
    </ConfigProvider>
  </StrictMode>,
)
