import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateChallenges } from './shared/challenge-browser.js'
import { emptySamples, sampleEvidence } from './sampleEvidence.ts'

test('a new round has three distinct prompts and no output or success state', () => {
  const challenges = generateChallenges(3)
  const next = generateChallenges(3)
  assert.equal(challenges.length, 3)
  assert.equal(new Set(challenges.map(item => item.id)).size, 3)
  assert.notDeepEqual(challenges, next)
  for (const item of emptySamples(challenges)) {
    assert.ok(item.prompt)
    assert.ok(item.expected_count >= 292 && item.expected_count <= 332)
    assert.equal(item.state, 'queued')
    assert.equal(item.output, '')
  }
})

test('streaming output and failed samples map to their own visible cards', () => {
  const challenges = generateChallenges(3)
  const samples = sampleEvidence(challenges, { completed: 1, total: 3, accepted: 0, message: '', challenges: [
    {text:'1 2 3 999', status:'receiving', state:'streaming'},
    {text:'5 6 7', status:'failed', state:'rejected', error:'HTTP 502 fixture-secret'},
    {text:'', status:'pending', state:'pending'},
  ] }, 'fixture-secret')
  assert.equal(samples[0].prompt, challenges[0].prompt)
  assert.equal(samples[0].output, '1 2 3 999')
  assert.equal(samples[0].count, 3)
  assert.equal(samples[0].state, 'streaming')
  assert.equal(samples[1].output, '5 6 7')
  assert.equal(samples[1].state, 'failed')
  assert.equal(samples[1].error, 'HTTP 502 [REDACTED]')
  assert.equal(samples[2].state, 'queued')
})

test('displayed outputs are bounded and credential redaction happens before copying', () => {
  const samples = sampleEvidence(generateChallenges(1), { completed: 1, total: 1, accepted: 1, message: '', challenges: [
    {text:'fixture-secret '+ '1 '.repeat(10000),status:'done',state:'done'},
  ]}, 'fixture-secret')
  assert.equal(samples[0].state, 'complete')
  assert.equal(samples[0].output.length, 16384)
  assert.equal(samples[0].output_truncated, true)
  assert.ok(!samples[0].output.includes('fixture-secret'))
})
