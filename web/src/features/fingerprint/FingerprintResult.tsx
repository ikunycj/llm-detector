import { Alert, Collapse, Space, Table, Tag, Typography } from 'antd'
import type { FingerprintDetails } from '../../types'
import FingerprintSampleCard from './FingerprintSampleCard'

const decisions: Record<string, string> = { scored: '完整排名', partial: '部分样本排名', unscorable: '样本不足', not_model: '回答不像语言模型' }
export default function FingerprintResult({ details }: { details: FingerprintDetails }) {
  // Older failed reports stored a null candidate list before any ranking was available.
  const candidates = details.candidates ?? []
  return <div className="inspection-log-detail">
    <Space wrap>
      {details.prediction_name && <Typography.Text strong>最相似候选：{details.prediction_name}</Typography.Text>}
      {details.decision && <Tag>{decisions[details.decision] || details.decision}</Tag>}
      {details.probability != null && <Tag color="blue">参考库内概率 {(details.probability * 100).toFixed(1)}%</Tag>}
      <Tag>参考数据 {details.reference_built_at || '未知版本'}</Tag>
    </Space>
    {details.error && <Alert type="warning" showIcon title={details.error} />}
    {details.evidence && <Alert type={details.evidence.insufficient ? 'warning' : 'info'} showIcon title={details.evidence.label} description={details.evidence.reason} />}
    <Collapse defaultActiveKey={['samples']} items={[
      { key: 'samples', label: `提示词与输出（${details.samples.length} 个样本）`, children: details.samples.length ? <div className="fingerprint-samples-grid">{details.samples.map((sample, index) => <FingerprintSampleCard key={`${sample.challenge_id}:${index}`} sample={sample} index={index} />)}</div> : <Typography.Text type="secondary">此记录没有保存样本数据。</Typography.Text> },
      { key: 'candidates', label: `候选排名（${candidates.length}）`, children: <Table rowKey="model" size="small" dataSource={candidates} pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 600 }} columns={[
        { title: '候选模型', dataIndex: 'display_name', render: (name: string, item) => name || item.model },
        { title: '系列', dataIndex: 'family_name', render: (name: string, item) => name || item.family || '—' },
        { title: '排名分数', dataIndex: 'score', render: (score: number) => score.toFixed(6) },
        { title: '参考库概率', dataIndex: 'probability', render: (value: number | null) => value == null ? '不可用' : `${(value * 100).toFixed(1)}%` },
      ]} /> },
    ]} />
    <Typography.Text type="secondary">指纹排名只在有限参考库内比较，不构成模型身份认证。</Typography.Text>
  </div>
}
