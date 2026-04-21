/**
 * Model pricing table per §7.
 * Backend-defined allowlist — not live API discovery.
 */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'gpt-4.1-mini':  { inputPer1M: 0.40, outputPer1M: 1.60 },
  'gpt-4.1-nano':  { inputPer1M: 0.10, outputPer1M: 0.40 },
  'gpt-4.1':       { inputPer1M: 2.00, outputPer1M: 8.00 },
  'gpt-4o':        { inputPer1M: 2.50, outputPer1M: 10.00 },
  'gpt-4o-mini':   { inputPer1M: 0.15, outputPer1M: 0.60 },
};

/**
 * Calculate cost from token counts per §7.
 * cost = (inputTokens / 1_000_000 * inputPer1M) + (outputTokens / 1_000_000 * outputPer1M)
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`Unknown model "${model}" — cost calculated as $0. Add to MODEL_PRICING if this is intentional.`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
         (outputTokens / 1_000_000) * pricing.outputPer1M;
}

/**
 * Returns the list of supported models for the dropdown.
 */
export function getModelList(): Array<{ id: string; name: string; inputPer1M: number; outputPer1M: number }> {
  return Object.entries(MODEL_PRICING).map(([id, pricing]) => ({
    id,
    name: id,
    ...pricing,
  }));
}

/**
 * Validate that a model is in the allowlist.
 */
export function isValidModel(model: string): boolean {
  return model in MODEL_PRICING;
}
