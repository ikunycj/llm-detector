import { decompress } from 'fzstd'
import { decodeDetector } from './shared/detector-codec'
import { testApi } from './shared/detection'
import { generateChallenges } from './shared/challenge-browser.js'
import { analyzeSharedOutputs } from './shared/shared-detector'
import type { Analysis, ApiConfig, Bank, CollectionProgress } from './shared/types'
import type { SharedDetector } from './shared/shared-detector'

const dataBase = 'https://lm.ikale.io/data/'
let manifestPromise: Promise<Record<string, { parts: string[]; bytes: number }>> | undefined
let bankPromise: Promise<Bank> | undefined
let detectorPromise: Promise<SharedDetector> | undefined
async function manifest() { return manifestPromise ??= fetch(`${dataBase}manifest.json`, { cache: 'no-store' }).then((response) => { if (!response.ok) throw new Error('Fingerpoint 参考数据清单加载失败'); return response.json() }) }
async function bytes(name: string) {
  const entry = (await manifest())[name]; if (!entry?.parts?.length) throw new Error(`Fingerpoint 参考数据缺少 ${name}`)
  const parts = await Promise.all(entry.parts.map(async (part: string) => { const response = await fetch(`${dataBase}chunks/${part}`); if (!response.ok) throw new Error('Fingerpoint 参考数据下载失败'); return new Uint8Array(await response.arrayBuffer()) }))
  const total = parts.reduce((sum, part) => sum + part.length, 0); const combined = new Uint8Array(total); let offset = 0
  for (const part of parts) { combined.set(part, offset); offset += part.length }
  return decompress(combined)
}
async function loadBank() { return bankPromise ??= bytes('unified_bank.json').then((data) => JSON.parse(new TextDecoder().decode(data)) as Bank) }
async function loadDetector() { return detectorPromise ??= bytes('shared_detector.bin').then((data) => decodeDetector(data)) }
export type BrowserFingerprintConfig = { baseUrl: string; apiKey: string; model: string; protocol: 'chat_completions' | 'responses' | 'messages'; count?: number; strict?: boolean }
export async function detectBrowser(config: BrowserFingerprintConfig, onProgress?: (progress: CollectionProgress) => void, signal?: AbortSignal) {
  const apiConfig: ApiConfig = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, effort: '', format: config.protocol === 'messages' ? 'anthropic' : config.protocol === 'responses' ? 'responses' : 'openai', serviceTier: 'default', stream: true, parallel: true, relaxed: !config.strict }
  const challenges = generateChallenges(Math.min(3, Math.max(1, config.count || 3)))
  const outputs = await testApi(apiConfig, challenges, onProgress || (() => {}), signal)
  const [bank, detector] = await Promise.all([loadBank(), loadDetector()])
  const analysis: Analysis = analyzeSharedOutputs(outputs, bank, detector, { allowPartial: !config.strict })
  return { analysis, samples: challenges.map((challenge, index) => ({ challenge_id: challenge.id, expected_count: challenge.expected_count, state: 'complete', count: outputs[index]?.text.match(/\d+/g)?.length || 0, first_byte_ms: null, response_model: null, error: null })), reference_built_at: bank.built_at, model_version: { base_sha256: bank.reference_sha256 || '' } }
}
