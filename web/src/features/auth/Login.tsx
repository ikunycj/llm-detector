import { LockOutlined, LoginOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd'
import { useState } from 'react'
import { login } from '../../api'

export default function Login({ onLogin, notice }: { onLogin: (token: string) => void; notice: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(values: { key: string }) {
    setBusy(true)
    setError('')
    try {
      const result = await login(values.key)
      onLogin(result.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <Card className="auth-card" bordered={false}>
        <Space orientation="vertical" size={24} style={{ width: '100%' }}>
          <Space size={12} className="brand">
            <span className="brand-mark" aria-hidden="true">L</span>
            <Typography.Text strong>LLM Detector</Typography.Text>
          </Space>
          <div>
            <Typography.Title level={1}>模型智力巡检</Typography.Title>
            <Typography.Paragraph type="secondary">输入开发环境中的访问密钥，进入巡检工作台。</Typography.Paragraph>
          </div>
          {notice && <Alert message={notice} type="info" showIcon />}
          <Form layout="vertical" onFinish={submit} requiredMark={false}>
            <Form.Item
              label="访问密钥"
              name="key"
              rules={[{ required: true, message: '请输入访问密钥' }]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder=".env 中的 APP_LOGIN_KEY" autoComplete="current-password" disabled={busy} />
            </Form.Item>
            {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}
            <Button type="primary" htmlType="submit" block icon={<LoginOutlined />} loading={busy}>
              进入工作台
            </Button>
          </Form>
          <Typography.Text type="secondary" className="auth-note">会话只保留在当前页面，刷新后需要重新登录。</Typography.Text>
        </Space>
      </Card>
    </main>
  )
}
