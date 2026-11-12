import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceID, recordKey, sourceName } from './sources.ts'

test('equal record IDs in browser and cloud remain distinct', () => {
  const sources = ['local', 'cloud']
  assert.equal(new Set(sources.map(source => recordKey({ id: 'same', source }))).size, 2)
  assert.equal(sourceID({ mode: 'cloud', token: 'fixture' }), 'cloud')
  assert.equal(sourceName('cloud'), '云端')
  assert.equal(sourceName('local'), '本地')
})
