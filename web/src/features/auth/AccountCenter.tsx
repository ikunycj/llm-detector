import { DesktopOutlined, LockOutlined, LoginOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Divider, Form, Input, Tabs, Typography } from 'antd'
import { useState } from 'react'
import { login, register, type CloudSession } from '../../api'
import type { SourceID } from '../../data/sources'

export default function AccountCenter({ session, saveLocation, onLogin, onLogout, onOpenLocal }: {
  session?: CloudSession
  saveLocation: SourceID
  onLogin: (session: CloudSession) => void
  onLogout: () => Promise<void>
  onOpenLocal: () => void
}) {
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(values: { username: string; password: string }) {
    setBusy(true)
    setError('')
    try {
      const result = await (mode === 'register' ? register : login)(values.username, values.password)
      onLogin(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号服务不可用')
    } finally {
      setBusy(false)
    }
  }
  async function signOut() {
    setBusy(true)
    setError('')
    try { await onLogout() }
    catch (err) { setError(err instanceof Error ? err.message : '退出失败') }
    finally { setBusy(false) }
  }
  return <>
    {session ? <>
      <Descriptions column={1} size="small" items={[
        { key: 'username', label: '账号', children: session.user.username },
        { key: 'expiry', label: '登录有效期', children: new Date(session.expires_at).toLocaleString('zh-CN') },
        { key: 'location', label: '数据默认保存位置', children: saveLocation === 'cloud' ? '云端' : '浏览器本地' },
      ]} />
      <Typography.Paragraph type="secondary" style={{ marginTop: 20 }}>云端数据属于当前账号。本地数据只保存在此浏览器，登录不会自动上传或覆盖它们。</Typography.Paragraph>
      <Button icon={<LogoutOutlined />} onClick={() => void signOut()} loading={busy}>退出登录</Button>
    </> : <>
      <Tabs activeKey={mode} onChange={(value) => { setMode(value); setError('') }} items={[
        { key: 'login', label: '登录', disabled: busy },
        { key: 'register', label: '注册', disabled: busy },
      ]} />
      <Typography.Paragraph type="secondary">登录态保留 24 小时，登录后默认保存到云端，也可在顶部切换为本地。</Typography.Paragraph>
      <Form name="cloud-account" layout="vertical" onFinish={submit} disabled={busy}>
        <Form.Item label="账号" name="username" rules={[{ required: true, whitespace: true, message: '请输入账号' }]}>
          <Input prefix={<UserOutlined />} autoComplete="username" placeholder="输入账号" />
        </Form.Item>
        <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password prefix={<LockOutlined />} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder="输入密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block icon={<LoginOutlined />} loading={busy}>
          {mode === 'register' ? '注册并登录' : '登录'}
        </Button>
      </Form>
    </>}
    {error && <Alert type="error" title={error} showIcon style={{ marginTop: 16 }} />}
    <Divider />
    <Button icon={<DesktopOutlined />} onClick={onOpenLocal} disabled={busy}>本机执行器</Button>
    <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>本地 Terminal Bench 和项目巡检需要执行器。浏览器指纹检测可直接运行。</Typography.Paragraph>
  </>
}
