import { Alert, Button, Divider, Select, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { connectLocal, dependencyState, disconnectLocal, getBenchReadiness, installHarbor, probeLocalRuntime, removeHarbor, type APIClient } from '../api'
import type { BenchReadiness } from '../features/terminalbench/types'

export default function LocalRuntime({ client, onConnected, onDisconnected }: { client: APIClient; onConnected: (token: string) => void; onDisconnected?: () => void }) {
  const [platform, setPlatform] = useState(navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Win') ? 'windows' : 'linux')
  const [arch, setArch] = useState('arm64')
  const [detected, setDetected] = useState<boolean>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [readiness, setReadiness] = useState<BenchReadiness>()

  async function probe() {
    setDetected(await probeLocalRuntime())
  }

  useEffect(() => { void probe() }, [])

  useEffect(() => {
    if (!client.token || !installing) return
    let stopped = false; let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await dependencyState(client)
        if (stopped) return
        setInstalling(result.running)
        if (result.error) setError(result.error)
        if (result.running) timer = setTimeout(poll, 1500)
      } catch {
        if (!stopped) { setInstalling(false); setError('无法读取本机安装进度，请检查执行器') }
      }
    }
    void poll(); return () => { stopped = true; clearTimeout(timer) }
  }, [client, installing])

  async function connect() {
    setBusy(true); setError(''); setNotice('')
    try { const result = await connectLocal(); onConnected(result.token); setDetected(true); setNotice('已连接本机执行器。以后打开页面可直接自动连接。') }
    catch (err) { setError(err instanceof TypeError ? '无法连接 127.0.0.1:9002。请先启动执行器，并确认页面来源已加入允许列表。' : err instanceof Error ? err.message : '连接失败') }
    finally { setBusy(false) }
  }

  async function disconnect() {
    if (!client.token) return
    setBusy(true); setError(''); setNotice('')
    try { await disconnectLocal(client); onDisconnected?.(); setReadiness(undefined); setNotice('已断开本机执行器。') }
    catch (err) { setError(err instanceof Error ? err.message : '断开失败') }
    finally { setBusy(false) }
  }

  async function removeDependencies() {
    if (!client.token) return
    setRemoving(true); setError(''); setNotice('')
    try { await removeHarbor(client); setReadiness(undefined); setNotice('本机 Python / Harbor 依赖已删除。Docker 和 Git 未删除。') }
    catch (err) { setError(err instanceof Error ? err.message : '删除本机依赖失败') }
    finally { setRemoving(false) }
  }

  return <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <Alert type="info" showIcon title="无需配对码即可连接本机执行器" description="页面会自动检测 127.0.0.1:9002。点击连接后会建立本地会话；会话保存在当前浏览器，刷新页面无需重复操作。" />
    <Space wrap>
      <Tag color={detected ? 'success' : detected === false ? 'warning' : 'default'}>{detected ? '已发现本机执行器' : detected === false ? '未发现本机执行器' : '正在检测本机执行器'}</Tag>
      {client.token && <Tag color="success">本机连接已恢复</Tag>}
      <Button size="small" onClick={() => void probe()}>重新检测</Button>
    </Space>
    <Typography.Text strong>1. 下载并启动本机执行器</Typography.Text>
    <Space wrap><Select aria-label="操作系统" value={platform} onChange={setPlatform} options={[{ value: 'darwin', label: 'macOS' }, { value: 'windows', label: 'Windows' }, { value: 'linux', label: 'Linux' }]} /><Select aria-label="CPU 架构" value={arch} onChange={setArch} options={[{ value: 'arm64', label: 'ARM64 / Apple Silicon' }, { value: 'amd64', label: 'x64 / Intel / AMD' }]} /></Space>
    <Button href={`/downloads/llm-detector-local-${platform}-${arch}.zip`} download>下载本机执行器</Button>
    <Typography.Paragraph type="secondary">解压后运行 start 文件；启动后页面会自动发现它。当前提供未签名开发构建，Windows 的 Harbor / Docker 环境尚需单独验证。</Typography.Paragraph>
    <Typography.Text strong>2. 连接浏览器</Typography.Text>
    {client.token ? <Space wrap><Tag color="success">本机执行器已连接</Tag><Button danger onClick={() => void disconnect()} loading={busy}>断开连接</Button></Space> : <Space wrap><Button type="primary" onClick={() => void connect()} loading={busy} disabled={!detected}>连接本机执行器</Button><Typography.Text type="secondary">无需复制配对码；页面来源由执行器的 `--origin` 参数控制。</Typography.Text></Space>}
    {notice && <Alert type="success" showIcon title={notice} />}
    {error && <Alert type="error" showIcon title={error} />}
    <Divider />
    <Typography.Text strong>3. Terminal Bench 运行依赖</Typography.Text>
    <Typography.Paragraph>指纹检测无需 Python。Terminal Bench 需要 Python 3.12、Harbor、Docker 和 Git。</Typography.Paragraph>
    <Space wrap><Button disabled={!client.token || installing} loading={busy} onClick={async () => { setBusy(true); setError(''); try { setReadiness(await getBenchReadiness(client)) } catch { setError('本机环境检查失败') } finally { setBusy(false) } }}>检查本机环境</Button>
      <Button disabled={!client.token || removing} loading={installing} onClick={async () => { setError(''); try { const result = await installHarbor(client); setInstalling(result.running) } catch { setError('无法开始依赖安装') } }}>安装 Python / Harbor 依赖</Button>
      <Button danger disabled={!client.token || installing || removing} loading={removing} onClick={() => void removeDependencies()}>删除 Python / Harbor 依赖</Button></Space>
    {readiness?.checks.map((check) => <Alert key={check.name} type={check.ready ? 'success' : 'warning'} title={`${check.name}：${check.detail}`} showIcon />)}
    <Space><Button href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noopener noreferrer">下载 Docker</Button><Button href="https://git-scm.com/downloads" target="_blank" rel="noopener noreferrer">下载 Git</Button></Space>
    <Typography.Text type="secondary">删除按钮只删除本机 Python / Harbor 缓存，不删除 Docker、Git 或任务结果。Terminal Bench 运行中禁止删除依赖。</Typography.Text>
  </Space>
}
