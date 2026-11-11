import { LockOutlined, LoginOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { login, type User } from '../../api'

export default function Login({ onLogin }: { onLogin: (token: string, user: User, expires_at: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(values: { username: string; password: string }) {
    setBusy(true); setError('')
    try { const result = await login(values.username, values.password); onLogin(result.token, result.user, result.expires_at) }
    catch (err) { setError(err instanceof Error ? err.message : '登录失败') }
    finally { setBusy(false) }
  }
  return <>
    <Typography.Paragraph type="secondary">登录后使用你的云端配置、计划和历史。本地数据不会自动上传。</Typography.Paragraph>
    <Form layout="vertical" onFinish={submit}>
      <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}><Input prefix={<UserOutlined />} autoComplete="username" disabled={busy} /></Form.Item>
      <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} autoComplete="current-password" disabled={busy} /></Form.Item>
      {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 16 }} />}
      <Button type="primary" htmlType="submit" block icon={<LoginOutlined />} loading={busy}>登录云端</Button>
    </Form>
  </>
}
