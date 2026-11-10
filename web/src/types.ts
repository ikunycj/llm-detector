export type Provider = {
  id: string
  name: string
}

export type Evaluator = {
  id: string
  name: string
  version: string
  description: string
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
  report: { checks: Check[] }
  error?: string
}

export type Scan = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed'
  vendor: string
  evaluator: Evaluator
  scope: 'all' | 'selected'
  models: ModelResult[]
  error?: string
  created_at: string
  started_at?: string
  completed_at?: string
}
