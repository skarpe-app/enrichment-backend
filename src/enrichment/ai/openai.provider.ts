import OpenAI from 'openai';
import type { AiProvider, ClassificationInput, ClassificationResult } from './types.js';
import { AiTimeoutError, AiParseError } from './types.js';
import { calculateCost } from './cost.js';

const AI_TIMEOUT_MS = 60_000;
const AI_RETRY_DELAYS = [1000, 4000, 16000]; // 3 attempts with backoff per §7

export class OpenAiProvider implements AiProvider {
  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < AI_RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        await sleep(AI_RETRY_DELAYS[attempt - 1]);
      }

      try {
        return await this.callApi(input);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only retry on timeout or transient errors
        if (!(err instanceof AiTimeoutError) && !(err instanceof AiParseError)) {
          throw err; // Non-retriable (auth error, invalid model, etc.)
        }
      }
    }

    throw lastError ?? new Error('AI classification failed after retries');
  }

  private async callApi(input: ClassificationInput): Promise<ClassificationResult> {
    const client = new OpenAI({ apiKey: input.apiKey });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    const startMs = Date.now();

    try {
      let response: any;

      if (input.promptMode === 'prompt_id') {
        // Mode 1: Stored prompt per §7
        response = await client.responses.create(
          {
            model: input.aiModel,
            input: '',
            prompt: {
              id: input.promptId!,
              ...(input.promptVersion ? { version: input.promptVersion } : {}),
              variables: {
                html: input.combinedDigest,
              },
            },
          } as any,
          { signal: controller.signal }
        );
      } else {
        // Mode 2: Text prompt per §7
        response = await client.responses.create(
          {
            model: input.aiModel,
            instructions: input.promptText!,
            input: `Website content:\n${input.combinedDigest}`,
            text: {
              format: {
                type: 'json_schema',
                name: 'industry_classification',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    industry: { type: 'string' },
                    sub_industry: { type: ['string', 'null'] },
                    confidence: { type: 'integer', minimum: 1, maximum: 10 },
                    reasoning: { type: 'string' },
                  },
                  required: ['industry', 'sub_industry', 'confidence', 'reasoning'],
                  additionalProperties: false,
                },
              },
            },
          } as any,
          { signal: controller.signal }
        );
      }

      const classifyMs = Date.now() - startMs;

      // Parse response per §16
      const parsed = parseAiResponse(response);

      // Token extraction
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const costUsd = calculateCost(input.aiModel, inputTokens, outputTokens);

      return {
        industry: parsed.industry,
        subIndustry: parsed.sub_industry,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        inputTokens,
        outputTokens,
        costUsd,
        classifyMs,
      };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AiTimeoutError('openai_timeout_60s');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ─── Response parsing per §16 ────────────────────────────────────────────────

interface AiOutputShape {
  industry: string;
  sub_industry: string | null;
  confidence: number;
  reasoning: string;
}

function parseAiResponse(response: any): AiOutputShape {
  // Primary path: response.output_text
  let rawText = response.output_text;

  // Fallback path per §16
  if (!rawText) {
    const outputItems = response.output ?? [];
    const textParts: string[] = [];
    for (const item of outputItems) {
      if (item.type === 'message') {
        for (const content of item.content ?? []) {
          if (content.type === 'output_text') {
            textParts.push(content.text);
          }
        }
      }
    }
    rawText = textParts.join('');
  }

  if (!rawText) {
    throw new AiParseError('Empty AI output');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new AiParseError(`Unparseable AI output: ${rawText.substring(0, 200)}`);
  }

  // Field validation
  if (!parsed.industry || typeof parsed.industry !== 'string') {
    throw new AiParseError('Missing or invalid "industry" field');
  }
  if (!parsed.reasoning || typeof parsed.reasoning !== 'string') {
    throw new AiParseError('Missing or invalid "reasoning" field');
  }

  // Also accept "classification" as alias for "industry" (common in prompts)
  const industry = parsed.industry ?? parsed.classification;
  if (!industry || typeof industry !== 'string') {
    throw new AiParseError('Missing industry/classification field');
  }

  // Confidence normalization per §16
  let confidence = parsed.confidence;
  if (typeof confidence === 'number') {
    if (confidence >= 0 && confidence <= 1) confidence = Math.round(confidence * 10);
    else if (confidence > 10 && confidence <= 100) confidence = Math.round(confidence / 10);
    confidence = Math.max(1, Math.min(10, Math.round(confidence)));
  } else {
    confidence = 5; // Default if missing
  }

  return {
    industry,
    sub_industry: typeof parsed.sub_industry === 'string' ? parsed.sub_industry : null,
    confidence,
    reasoning: parsed.reasoning,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
