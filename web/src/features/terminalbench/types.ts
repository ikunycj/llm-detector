export type BenchCatalog = {
  dataset: string
  source_project: string
  harbor_version: string
  agent: string
  daily: string[]
  tasks: Array<{ name: string; git_url: string; git_commit_id: string; path: string }>
}
export type BenchInput = {
  service_id?: string
  suite: 'daily' | 'full'
  service_name: string
  base_url: string
  api_key: string
  protocol: 'chat_completions' | 'responses' | 'messages'
  model: string
  concurrency: number
}
export type BenchReadiness = { ready: boolean; checks: Array<{ name: string; ready: boolean; detail: string }> }
export type BenchJob = Omit<BenchInput, 'api_key'> & {
  id: string
  source?: 'local' | 'cloud'
  dataset: string
  agent: string
  harbor_version: string
  status: string
  error?: string
  created_at: string
  finished_at?: string
  trials: Array<{ name: string; status: string; reward: number | null; error?: string; started_at?: string; finished_at?: string }>
}
