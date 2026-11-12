import { Alert, Button, Layout, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { getCatalog } from '../../api'
import type { Evaluator } from '../../types'
import ModelAPIs from './ModelAPIs'
import type { LogNavigation } from '../logs/records'
import type { SavedModelService } from './savedServices'
import ScanDialog from './ScanDialog'
const { Content, Footer } = Layout
export default function Workbench({ onOpenLogs }: LogNavigation) {
  const [service, setService] = useState<SavedModelService>()
  const [engines, setEngines] = useState<Evaluator[]>([])
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    getCatalog(controller.signal)
      .then((catalog) => {
        setEngines(catalog.evaluators)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message)
      })
    return () => controller.abort()
  }, [])
  return (
    <Layout>
      <Content className="app-content scan-content">
        <div className="page-heading">
          <Typography.Title level={1}>首页</Typography.Title>
          <Typography.Text type="secondary">选择模型 API 和巡检引擎，执行结果统一在巡检日志中查看。</Typography.Text>
        </div>
        {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
        <ModelAPIs canInspect={engines.length > 0} onInspect={setService} />
        {service && (
          <ScanDialog
            service={service}
            engines={engines}
            onClose={() => setService(undefined)}
            onComplete={() => setSubmitted(true)}
          />
        )}
        {submitted && <Alert type="success" showIcon title="巡检已提交" action={<Button onClick={() => onOpenLogs()}>查看巡检日志</Button>} />}
      </Content>
      <Footer className="app-footer">每条数据标明来源。选择执行位置后才会发送模型请求。</Footer>
    </Layout>
  )
}
