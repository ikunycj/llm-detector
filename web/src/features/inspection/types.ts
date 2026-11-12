import type { Scan } from '../../types'

export type ProjectChannel = {
  id: string
  name: string
  groups: string[]
  tag?: string
  base_url: string
  protocol: string
  protocol_override?: 'chat_completions' | 'responses' | 'messages'
  organization?: string
  models: string[]
  enabled: boolean
  issue?: string
  multi_key: boolean
  has_key: boolean
  key_error?: string
}
export type InspectionPlan = {
  mode: 'all' | 'groups' | 'channels'
  groups: string[]
  channel_ids: string[]
  models: string[]
  evaluators: string[]
  evaluator_options?: Record<string, Record<string, unknown>>
  enabled: boolean
  interval_minutes: number
}
export type InspectionProject = {
  source?: import('../../data/sources').SourceID
  admin_account?: string
  id: string
  name: string
  kind: string
  base_url: string
  user_id: number
  has_token: boolean
  channels: ProjectChannel[]
  groups: string[]
  plan: InspectionPlan
  synced_at?: string
  next_run_at?: string
  busy: boolean
  last_error?: string
}
export type ProjectInput = { admin_account?: string; password?: string; login_code?: string; name: string; kind: string; base_url: string; user_id: number; access_token: string }
export type BatchRun = {
  source?: import('../../data/sources').SourceID
  id: string
  project_id: string
  project_name: string
  trigger: string
  status: string
  created_at: string
  completed_at?: string
  error?: string
  items: Array<{
    channel_id: string
    channel_name: string
    groups: string[]
    evaluator: string
    protocol?: string
    models: string[]
    status: string
    error?: string
    scan_id?: string
    result?: Scan
  }>
}
