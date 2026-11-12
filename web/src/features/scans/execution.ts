import { createScan, discoverModels, type APIClient, type Connection } from '../../api'
import { mergeLocal } from '../../data/local'
import type { Evaluator, FingerprintDetails, ModelResult, Scan } from '../../types'
import { detectBrowser, type Challenge } from '../../vendor/fingerpoint/browser'

export async function executeEngine(
  client: APIClient,
  connection: Connection,
  engine: Evaluator,
  scope: 'all' | 'selected',
  models: string[],
  options: Record<string, unknown> & { challenges?: Challenge[] } = {},
  onSamples?: (samples: FingerprintDetails['samples']) => void,
) {
  if (scope === 'all' && engine.requires_explicit_models) {
    models = (await discoverModels(client, connection)).models.map((model) => model.id)
    if (!models.length) throw new Error('模型列表为空，请在模型 API 中指定模型')
    scope = 'selected'
  }
  if (client.mode !== 'local' || engine.id !== 'fingerprint')
    return createScan(client, {
      ...connection,
      evaluator: engine.id,
      scope,
      models,
      evaluator_options: engine.id === 'fingerprint' ? { ...options, api: connection.protocol } : options,
    })
  const created = new Date().toISOString()
  const results: ModelResult[] = []
  for (const model of models) {
    try {
      const result = await detectBrowser(
        {
          baseUrl: connection.base_url,
          apiKey: connection.api_key,
          model,
          protocol: connection.protocol,
          count: Number(options.count || 3),
          strict: options.strict === true,
          challenges: options.challenges,
        },
        onSamples,
        AbortSignal.timeout(Number(options.timeout_seconds || 120) * 1000),
      )
      const analysis = result.analysis
      const details: FingerprintDetails = {
        decision: analysis?.decision,
        prediction: analysis?.prediction,
        prediction_name: analysis?.prediction_name,
        family_prediction_name: analysis?.family_prediction_name,
        probability: analysis?.probability ?? null,
        probability_scope: null,
        ranking_score: analysis?.ranking_score ?? null,
        candidates: analysis?.results || [],
        samples: result.samples,
        reference_built_at: result.reference_built_at,
        model_version: result.model_version,
        evidence: analysis?.evidence || null,
        error: result.error,
        disclaimer: '指纹结果仅在参考库内比较，不是身份认证。',
      }
      results.push({
        model: { id: model, name: model },
        status: result.error ? 'error' : 'completed',
        report: { checks: [], kind: 'fingerprint', details },
        error: result.error,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '浏览器直连失败，请检查供应商跨域设置'
      results.push({
        model: { id: model, name: model },
        status: 'error',
        report: { checks: [], kind: 'fingerprint' },
        error: connection.api_key ? message.replaceAll(connection.api_key, '[REDACTED]') : message,
      })
    }
  }
  const scan: Scan = {
    id: `browser-${crypto.randomUUID()}`,
    source: 'local',
    status: results.some((item) => item.status === 'error') ? 'completed_with_errors' : 'completed',
    vendor: connection.vendor,
    service_name: connection.service_name,
    evaluator: engine,
    scope,
    models: results,
    created_at: created,
    completed_at: new Date().toISOString(),
  }
  await mergeLocal('scans', [scan])
  return scan
}
