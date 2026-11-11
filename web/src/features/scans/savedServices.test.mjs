import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { parseImportedServices, parseModelAPI, readSavedServices, writeSavedServices } from './savedServices.ts'

const storageKey = 'llm-detector:model-services:v1'
const fixture = { name: 'API A', protocol: 'responses', base_url: 'https://fixture.invalid/v1', api_key: 'fixture-secret', scope: 'selected', models: ['model-a'] }
let stored
beforeEach(() => {
  stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value) },
  } })
})

test('multiple APIs round-trip with independent protocol and model scope', () => {
  const configurations = parseImportedServices(JSON.stringify([
    { ...fixture, models: [' model-a ', 'model-a', 'model-b'] },
    { ...fixture, name: 'API B', protocol: 'messages', scope: 'all', models: [] },
  ]))
  const services = configurations.map((config, index) => ({ ...config, id: String(index), source: 'local', vendor: 'openai-compatible', service_name: config.name, updated_at: '2026-11-11T00:00:00Z' }))
  writeSavedServices(services)
  assert.deepEqual(readSavedServices(), services)
  assert.deepEqual(readSavedServices()[0].models, ['model-a', 'model-b'])
  assert.equal(readSavedServices()[1].scope, 'all')
  assert.deepEqual(readSavedServices()[1].models, [])
})

test('old connections preserve credentials and never migrate to all models', () => {
  const legacy = { id: 'existing', name: 'Existing API', vendor: 'openai-compatible', base_url: fixture.base_url, api_key: fixture.api_key, updated_at: '2026-11-10T00:00:00Z' }
  const raw = JSON.stringify([legacy])
  stored.set(storageKey, raw)
  const [service] = readSavedServices()
  assert.equal(service.id, legacy.id)
  assert.equal(service.api_key, legacy.api_key)
  assert.equal(service.protocol, 'chat_completions')
  assert.equal(service.scope, 'selected')
  assert.deepEqual(service.models, [])
  assert.equal(stored.get(storageKey), raw)
})

test('invalid imported row rejects the batch without exposing keys or overwriting existing data', () => {
  stored.set(storageKey, 'existing data')
  const input = JSON.stringify([fixture, { ...fixture, protocol: 'invalid', api_key: 'private-invalid-key' }])
  assert.throws(() => parseImportedServices(input), (err) => {
    assert.match(err.message, /第 2 项/)
    assert.doesNotMatch(err.message, /private-invalid-key/)
    return true
  })
  assert.equal(stored.get(storageKey), 'existing data')
})

test('local malformed or duplicate records are not silently dropped', () => {
  for (const value of ['not-json', '{}', JSON.stringify([fixture]), JSON.stringify([{ ...fixture, id: 'dup', vendor: 'x', updated_at: 'now' }, { ...fixture, id: 'dup', vendor: 'x', updated_at: 'now' }])]) {
    stored.set(storageKey, value)
    assert.throws(readSavedServices)
    assert.equal(stored.get(storageKey), value)
  }
})

test('model selection and connection fields are validated at import', () => {
  for (const update of [
    { name: '' }, { protocol: 'unsupported' }, { api_key: '' }, { api_key: 'key\nsecond' },
    { base_url: 'ftp://fixture.invalid' }, { base_url: 'https://user:password@fixture.invalid' }, { base_url: 'https://fixture.invalid?key=secret' },
    { scope: 'invalid' }, { models: [] }, { models: [''] }, { models: ['a', 42] }, { models: 'a' },
  ]) assert.throws(() => parseModelAPI({ ...fixture, ...update }))
  for (const raw of ['{}', '[]', '{bad}', 'null']) assert.throws(() => parseImportedServices(raw))
  assert.deepEqual(parseModelAPI({ ...fixture, scope: 'all', models: ['old'] }).models, [])
})

test('failed browser writes propagate rather than reporting success', () => {
  localStorage.setItem = () => { throw new Error('quota exceeded') }
  assert.throws(() => writeSavedServices([]), /quota exceeded/)
})
