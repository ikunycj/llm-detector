import { parseNumbers } from './shared/fingerprint-core.js'
import type { Challenge, CollectionProgress } from './shared/types'
import type { FingerprintDetails } from '../../types'

export type FingerprintSamples = FingerprintDetails['samples']

export function emptySamples(challenges: Challenge[]): FingerprintSamples {
  return challenges.map((challenge) => ({
    challenge_id: challenge.id, prompt: challenge.prompt, expected_count: challenge.expected_count,
    state: 'queued', count: 0, output: '', first_byte_ms: null, response_model: null, error: null,
  }))
}

// Preserve failed/partial samples and bound displayed evidence independently of
// the raw replies used by the official scoring implementation.
export function sampleEvidence(challenges: Challenge[], progress: CollectionProgress, key: string): FingerprintSamples {
  const states: Record<string, string> = { pending: 'queued', requesting: 'waiting', streaming: 'streaming', done: 'complete', capped: 'truncated', rejected: 'failed', stopped: 'cancelled' }
  return challenges.map((challenge, index) => {
    const sample = progress.challenges?.[index]
    const text = sample?.text || progress.outputs?.[index]?.text || ''
    const clean = key ? text.replaceAll(key, '[REDACTED]') : text
    const error = sample?.error ? (key ? sample.error.replaceAll(key, '[REDACTED]') : sample.error) : null
    return {
      challenge_id: challenge.id, prompt: challenge.prompt, expected_count: challenge.expected_count,
      state: states[sample?.state || 'pending'], count: parseNumbers(text).length,
      output: clean.slice(0, 16384), output_truncated: clean.length > 16384,
      first_byte_ms: sample?.throughput?.ttftMs ?? null, response_model: null, error,
    }
  })
}
