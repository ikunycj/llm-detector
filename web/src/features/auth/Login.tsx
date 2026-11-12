import { KeyOutlined, LoginOutlined } from '@ant-design/icons'
import { Alert, Button, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { login, type User } from '../../api'

export default function Login({ onLogin }: { onLogin: (token: string, user: User, expires_at: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(values: { key: string }) {
    setBusy(true); setError('')
    try {
      const result = await login(values.key)
      onLogin(result.token, result.user, result.expires_at)
    } catch (err) { setError(err instanceof Error ? err.message : '登录失败') }
    finally { setBusy(false) }
  }
  return <>
    <Typography.Paragraph type="secondary">云端地址已配置，输入访问密钥即可连接。登录态保留 24 小时，本地数据不会自动上传。</Typography.Paragraph>
    <Form name="cloud-login" layout="vertical" onFinish={submit}>
      <Form.Item label="云端访问密钥" name="key" rules={[{ required: true, message: '请输入云端访问密钥' }]}>
        <Input.Password prefix={<KeyOutlined />} autoComplete="off" disabled={busy} placeholder="服务端 .env 中的 APP_LOGIN_KEY" />
      </Form.Item>
      {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}
      <Button type="primary" htmlType="submit" block icon={<LoginOutlined />} loading={busy}>登录云端</Button>
    </Form>
  </>
}
