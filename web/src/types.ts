import type { BenchJob } from './features/terminalbench/types'

export type Provider = {
  id: string
  name: string
}

export type Evaluator = {
  id: string
  name: string
  description: string
  default?: boolean
  requires_explicit_models?: boolean
  options?: EvaluatorOption[]
}

export type EvaluatorOption = {
  key: string
  label: string
  kind: 'select' | 'number'
  default: string | number
  choices?: Array<{ value: string; label: string }>
  min?: number
  max?: number
}

export type Model = {
  id: string
  name: string
}

export type Check = {
  id: string
  name: string
  status: 'passed' | 'failed' | 'error'
  latency_ms?: number
  output?: string
  error?: string
}

export type ModelResult = {
  model: Model
  status: 'pending' | 'running' | 'completed' | 'error'
  report: { checks: Check[]; kind?: string; details?: FingerprintDetails | BenchJob; error?: string }
  error?: string
}

export type FingerprintDetails = {
  decision?: 'scored' | 'partial' | 'unscorable' | 'not_model' | string
  prediction?: string
  prediction_name?: string
  family_prediction?: string
  family_prediction_name?: string
  probability: number | null
  probability_status?: string
  probability_scope: string | null
  ranking_score: number | null
  candidates: Array<{
    model: string
    display_name: string
    family: string
    family_name: string
    score: number
    probability: number | null
  }>
  samples: Array<{
    challenge_id: string
    expected_count: number
    state: string
    count: number
    first_byte_ms: number | null
    response_model: string | null
    error: string | null
  }>
  reference_built_at: string
  model_version: { base_sha256: string }
  evidence: { insufficient: boolean; label: string; reason: string; method: string } | null
  error?: string
  disclaimer: string
}

export type Scan = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed'
  vendor: string
  service_name: string
  evaluator: Evaluator
  scope: 'all' | 'selected'
  models: ModelResult[]
  error?: string
  created_at: string
  started_at?: string
  completed_at?: string
}

export type AppPage = 'scan' | 'tasks' | 'engines'
