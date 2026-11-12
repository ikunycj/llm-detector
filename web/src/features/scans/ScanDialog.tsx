import { Alert, Checkbox, Divider, Form, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { connectionFor } from '../../api'
import { SourceTag, useLocations } from '../../app/Locations'
import { defaultEvaluatorIDs } from '../../evaluatorCatalog'
import type { Evaluator } from '../../types'
import { executeEngine } from './execution'
import { protocolLabels } from './ModelAPIEditor'
import type { SavedModelService } from './savedServices'

type ScanOptions = {
  engines: string[]
  options: Record<string, Record<string, string | number>>
}

export default function ScanDialog({
  service,
  engines,
  onClose,
  onComplete,
}: {
  service: SavedModelService
  engines: Evaluator[]
  onClose: () => void
  onComplete: () => void
}) {
  const { choose, owner, changed } = useLocations()
  const [form] = Form.useForm<ScanOptions>()
  const selected: string[] = Form.useWatch('engines', form) ?? defaultEvaluatorIDs(engines)
  const [phase, setPhase] = useState<'configuring' | 'choosing' | 'running'>('configuring')
  const [error, setError] = useState('')
  const busy = phase !== 'configuring'

  async function start(values: ScanOptions) {
    setError('')
    setPhase('choosing')
    try {
      const target = await choose({
        action: 'execute',
        title: `「${service.name}」在哪里巡检？`,
        from: service.source,
        requireRunner: values.engines.some((id) => id !== 'fingerprint'),
      })
      if (!target) return
      setPhase('running')
      const connection = await connectionFor(service, owner(service.source), target)
      for (const engine of engines.filter((item) => values.engines.includes(item.id))) {
        await executeEngine(target, connection, engine, service.scope, service.models, values.options[engine.id])
        changed()
        onComplete()
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '巡检启动失败')
    } finally {
      setPhase('configuring')
    }
  }

  return (
    <Modal
      title={`巡检 · ${service.name}`}
      open={phase !== 'choosing'}
      width={680}
      onCancel={onClose}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      cancelText="取消"
      cancelButtonProps={{ disabled: busy }}
      okText={phase === 'running' ? '正在巡检' : `选择执行位置 · ${selected.length} 个引擎`}
      okButtonProps={{ disabled: !selected.length }}
      confirmLoading={busy}
      onOk={() => form.submit()}
    >
      <div className="scan-dialog-target">
        <Space wrap>
          <SourceTag source={service.source} />
          <Tag>{protocolLabels[service.protocol]}</Tag>
          <Typography.Text>{service.scope === 'all' ? '全部模型（执行时获取列表）' : `指定 ${service.models.length} 个模型`}</Typography.Text>
        </Space>
        <Typography.Paragraph className="model-api-url" type="secondary">{service.base_url}</Typography.Paragraph>
        {service.scope === 'selected' && <Typography.Paragraph className="model-api-url">{service.models.join('、')}</Typography.Paragraph>}
      </div>
      {error && <Alert type="error" showIcon title={error} className="scan-dialog-error" />}
      <Form
        name="model-api-scan"
        form={form}
        layout="vertical"
        disabled={busy}
        initialValues={{
          engines: defaultEvaluatorIDs(engines),
          options: Object.fromEntries(engines.map((engine) => [
            engine.id,
            Object.fromEntries((engine.options || []).map((option) => [option.key, option.default])),
          ])),
        }}
        onFinish={start}
      >
        <Form.Item name="engines" label="巡检引擎（可多选）" rules={[{ required: true, message: '请选择至少一个巡检引擎' }]}>
          <Checkbox.Group options={engines.map((engine) => ({ value: engine.id, label: engine.name }))} />
        </Form.Item>
        {engines.filter((engine) => selected.includes(engine.id)).map((engine) => (
          <section key={engine.id} aria-label={`${engine.name}配置`}>
            <Divider titlePlacement="start">{engine.name}</Divider>
            <Typography.Paragraph type="secondary">{engine.description}</Typography.Paragraph>
            {engine.options?.map((option) => (
              <Form.Item
                key={option.key}
                name={['options', engine.id, option.key]}
                label={option.label}
                rules={option.kind === 'number'
                  ? [{ required: true, type: 'number', min: option.min, max: option.max, message: `请填写 ${option.min}–${option.max} 之间的数值` }]
                  : [{ required: true, message: `请选择${option.label}` }]}
              >
                {option.kind === 'select'
                  ? <Select options={option.choices} />
                  : <InputNumber min={option.min} max={option.max} />}
              </Form.Item>
            ))}
          </section>
        ))}
        <Typography.Paragraph type="secondary">
          下一步选择本地、云端或自建 Worker。确认执行位置后才会发起请求，结果保存在执行位置。
        </Typography.Paragraph>
      </Form>
    </Modal>
  )
}
