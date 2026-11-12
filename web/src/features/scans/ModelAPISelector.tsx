import { PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Select, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { readModelServices } from '../../api'
import { SourceTag, useLocations, useSourceData } from '../../app/Locations'
import { recordKey } from '../../data/sources'
import ModelAPIEditor from './ModelAPIEditor'
import type { SavedModelService } from './savedServices'
export const modelServiceKey = (service?: SavedModelService) => (service ? recordKey(service) : undefined)
const load = readModelServices
export default function ModelAPISelector({
  value,
  onChange,
  disabled,
}: {
  value?: string
  onChange: (service: SavedModelService | undefined) => void
  disabled?: boolean
}) {
  const { items, errors, loading, setItems } = useSourceData(load)
  const { label } = useLocations()
  const [creating, setCreating] = useState(false)
  const selected = items.find((item) => recordKey(item) === value)
  useEffect(() => {
    if (!loading && value && !selected) onChange(undefined)
  }, [loading, selected, value, onChange])
  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <Space.Compact style={{ width: '100%' }}>
        <Select
          aria-label="选择首页模型 API"
          style={{ flex: 1 }}
          loading={loading}
          disabled={disabled}
          showSearch
          optionFilterProp="label"
          placeholder="选择首页已保存的模型 API"
          value={value}
          onChange={(key) => onChange(items.find((item) => recordKey(item) === key))}
          options={items.map((item) => ({ value: recordKey(item), label: `${item.name} · ${label(item.source)}` }))}
        />
        <Button icon={<PlusOutlined />} onClick={() => setCreating(true)} disabled={disabled}>
          新增配置
        </Button>
      </Space.Compact>
      {selected && (
        <Space wrap>
          <SourceTag source={selected.source} />
          <Typography.Text type="secondary">{selected.base_url}</Typography.Text>
        </Space>
      )}
      {errors.map((message) => (
        <Alert key={message} type="warning" title={message} />
      ))}
      <ModelAPIEditor
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(item) => {
          setItems((current) => [...current.filter((row) => recordKey(row) !== recordKey(item)), item])
          onChange(item)
        }}
      />
    </Space>
  )
}
