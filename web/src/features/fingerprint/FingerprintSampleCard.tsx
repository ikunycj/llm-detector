import { CheckOutlined, CopyOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import { Button, Card, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import type { FingerprintDetails } from '../../types'

const { Text } = Typography
const states: Record<string, { text: string; color?: string }> = {
  queued: { text: '待取样' }, pending: { text: '待取样' }, waiting: { text: '请求中', color: 'processing' },
  streaming: { text: '接收中', color: 'processing' }, complete: { text: '完成', color: 'success' },
  truncated: { text: '已截取', color: 'warning' }, failed: { text: '出错', color: 'error' },
  cancelled: { text: '已中断', color: 'warning' },
}

export default function FingerprintSampleCard({ index, sample }: { index: number; sample: FingerprintDetails['samples'][number] }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')
  const status = sample.error ? states.failed : states[sample.state] || { text: sample.state }
  async function copy(kind: 'prompt' | 'output') {
    try {
      await navigator.clipboard.writeText(kind === 'prompt' ? sample.prompt || '' : sample.output || '')
      setCopied(kind); setCopyError('')
    } catch { setCopyError('复制失败，请手动选择文本复制。') }
  }
  return <Card className="fingerprint-sample-card" title={`样本 ${index + 1}`} extra={<Tag color={status.color}>{status.text}</Tag>}>
    <div className="fingerprint-sample-section">
      <div className="fingerprint-section-label"><Text type="secondary">提示词</Text><Button type="link" size="small" icon={copied === 'prompt' ? <CheckOutlined /> : <CopyOutlined />} disabled={!sample.prompt} aria-label={`复制样本 ${index + 1} 提示词`} onClick={() => void copy('prompt')}>{copied === 'prompt' ? '已复制' : '复制'}</Button></div>
      <div id={`fingerprint-prompt-${index}`} className={`fingerprint-prompt${expanded ? ' is-expanded' : ''}`}>{sample.prompt || '历史记录未保存提示词。'}</div>
      {sample.prompt && <Button type="link" className="fingerprint-expand" aria-expanded={expanded} aria-controls={`fingerprint-prompt-${index}`} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '展开'}{expanded ? <UpOutlined /> : <DownOutlined />}</Button>}
      <Text className="fingerprint-prompt-note" type="secondary">提示词随机使用中文、英文、日文、韩文或法文。</Text>
    </div>
    <div className="fingerprint-sample-section fingerprint-reply-section">
      <div className="fingerprint-section-label"><Text type="secondary">回复</Text>{sample.output && <Button type="link" size="small" icon={copied === 'output' ? <CheckOutlined /> : <CopyOutlined />} aria-label={`复制样本 ${index + 1} 输出`} onClick={() => void copy('output')}>{copied === 'output' ? '已复制' : '复制'}</Button>}</div>
      {sample.output ? <pre className="fingerprint-reply" aria-label={`样本 ${index + 1} 输出`}>{sample.output}</pre> : <div className="fingerprint-reply fingerprint-reply-empty" aria-label={`样本 ${index + 1} 输出`}><span>{['waiting', 'streaming'].includes(sample.state) ? '正在等待模型回复…' : sample.output === undefined ? '历史记录未保存回复文本' : sample.error ? '未收到有效回复' : '等待取样'}</span></div>}
      <div className="fingerprint-sample-message">
        {sample.error && <Text type="danger">{sample.error}</Text>}
        {sample.output_truncated && <Text type="secondary">回复过长，仅展示前 16,384 个字符；评分使用实际采集文本。</Text>}
        {copyError && <Text type="danger">{copyError}</Text>}
      </div>
      <Space wrap className="fingerprint-sample-metrics"><Text type="secondary">{sample.count} / {sample.expected_count} 个数字</Text>{sample.elapsed_ms != null && <Text type="secondary">· {(sample.elapsed_ms / 1000).toFixed(1)} 秒</Text>}{sample.first_byte_ms != null && <Text type="secondary">· 首字节 {(sample.first_byte_ms / 1000).toFixed(1)} 秒</Text>}</Space>
    </div>
  </Card>
}
