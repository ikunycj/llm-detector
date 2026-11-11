import type { Evaluator } from './types'

export function defaultEvaluatorIDs(evaluators: Evaluator[]) {
  return evaluators.filter((engine) => engine.default).map((engine) => engine.id)
}

export function explicitModelEvaluatorIDs(evaluators: Evaluator[]) {
  return new Set(evaluators.filter((engine) => engine.requires_explicit_models).map((engine) => engine.id))
}
