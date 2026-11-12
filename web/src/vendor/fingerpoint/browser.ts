import { decompress } from 'fzstd'
import { decodeDetector } from './shared/detector-codec'
import { testApi } from './shared/detection'
import { generateChallenges } from './shared/challenge-browser.js'
import { analyzeSharedOutputs } from './shared/shared-detector'
import type { Analysis, ApiConfig, Bank, Challenge, Output } from './shared/types'
import { emptySamples, sampleEvidence, type FingerprintSamples } from './sampleEvidence'
export { generateChallenges } from './shared/challenge-browser.js'
export type { Challenge } from './shared/types'
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
export type BrowserFingerprintConfig = { baseUrl: string; apiKey: string; model: string; protocol: 'chat_completions' | 'responses' | 'messages'; count?: number; strict?: boolean; challenges?: Challenge[] }
export async function detectBrowser(config: BrowserFingerprintConfig, onSamples?: (samples: FingerprintSamples) => void, signal?: AbortSignal) {
  const apiConfig: ApiConfig = { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, effort: '', format: config.protocol === 'messages' ? 'anthropic' : config.protocol === 'responses' ? 'responses' : 'openai', serviceTier: 'default', stream: true, parallel: true, relaxed: !config.strict }
  const challenges = config.challenges || generateChallenges(Math.min(3, Math.max(1, config.count || 3)))
  let samples = emptySamples(challenges)
  const started: Array<number | undefined> = challenges.map(() => undefined)
  const finished: Array<number | undefined> = challenges.map(() => undefined)
  let analysis: Analysis | undefined, error: string | undefined, referenceBuiltAt = '', baseSHA = ''
  onSamples?.(samples)
  try {
    const outputs: Output[] = await testApi(apiConfig, challenges, (progress) => {
      samples = sampleEvidence(challenges, progress, config.apiKey).map((sample, index) => {
        if (sample.state !== 'queued') started[index] ??= performance.now()
        if (['complete', 'truncated', 'failed', 'cancelled'].includes(sample.state)) finished[index] ??= performance.now()
        return { ...sample, elapsed_ms: started[index] == null ? undefined : Math.round((finished[index] ?? performance.now()) - started[index]!) }
      })
      onSamples?.(samples)
    }, signal)
    const [bank, detector] = await Promise.all([loadBank(), loadDetector()])
    referenceBuiltAt = bank.built_at
    baseSHA = detector.base_sha256
    analysis = analyzeSharedOutputs(outputs, bank, detector, { allowPartial: !config.strict })
  } catch (err) {
    const message = err instanceof Error ? err.message : '指纹检测失败'
    error = config.apiKey ? message.replaceAll(config.apiKey, '[REDACTED]') : message
    samples = samples.map((sample, index) => ['queued', 'waiting', 'streaming'].includes(sample.state)
      ? { ...sample, state: signal?.aborted ? 'cancelled' : 'failed', error: error!, elapsed_ms: started[index] == null ? undefined : Math.round(performance.now() - started[index]!) }
      : sample)
    onSamples?.(samples)
  }
  return { analysis, error, samples, reference_built_at: referenceBuiltAt, model_version: { base_sha256: baseSHA } }
}
