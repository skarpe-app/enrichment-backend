import type { PromptMode } from '@prisma/client';

export interface ClassificationInput {
  combinedDigest: string;
  promptMode: PromptMode;
  promptId?: string | null;
  promptVersion?: string | null;
  promptText?: string | null;
  promptHash?: string | null;
  aiModel: string;
  apiKey: string;
}

export interface ClassificationResult {
  industry: string;
  subIndustry: string | null;
  confidence: number;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  classifyMs: number;
}

export interface AiProvider {
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

export class AiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiTimeoutError';
  }
}

export class AiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiParseError';
  }
}
