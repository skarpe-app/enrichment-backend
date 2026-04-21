import { prisma } from '../db.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import type { AiProvider } from '@prisma/client';

export async function getSettings(userId: string) {
  const [profile, aiCredentials, customFields] = await Promise.all([
    prisma.profile.findUnique({ where: { id: userId } }),
    prisma.aiCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        label: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
        // api_key_enc is NEVER returned
      },
    }),
    prisma.customField.findMany({
      where: { userId },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  if (!profile) return null;

  return {
    profile: {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      role: profile.role,
      domainCacheTtlDays: profile.domainCacheTtlDays,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    },
    aiCredentials: aiCredentials.map((c) => ({
      id: c.id,
      provider: c.provider,
      label: c.label,
      isDefault: c.isDefault,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    customFields: customFields.map((f) => ({
      id: f.id,
      name: f.name,
      fieldKey: f.fieldKey,
      fieldType: f.fieldType,
      selectOptions: f.selectOptions.length > 0 ? f.selectOptions : null,
      sortOrder: f.sortOrder,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    })),
  };
}

export async function updateProfile(
  userId: string,
  data: { name?: string | null; domainCacheTtlDays?: number }
) {
  if (data.domainCacheTtlDays !== undefined) {
    if (data.domainCacheTtlDays < 1 || data.domainCacheTtlDays > 365) {
      throw new Error('domainCacheTtlDays must be between 1 and 365');
    }
  }

  return prisma.profile.update({
    where: { id: userId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.domainCacheTtlDays !== undefined ? { domainCacheTtlDays: data.domainCacheTtlDays } : {}),
    },
  });
}

// ─── AI Credential CRUD per §5.3 + §6 ───────────────────────────────────────

export async function createAiCredential(
  userId: string,
  data: { provider: AiProvider; label: string; apiKey: string; isDefault?: boolean }
) {
  // v1: only openai
  if (data.provider !== 'openai') {
    throw new SettingsError('invalid_provider', 'Only openai is supported in v1');
  }

  // Auto-default: if user has zero credentials for this provider, force isDefault=true
  const existingCount = await prisma.aiCredential.count({
    where: { userId, provider: data.provider },
  });
  const isDefault = existingCount === 0 ? true : (data.isDefault ?? false);

  // If setting as default, unset previous default in same transaction
  if (isDefault && existingCount > 0) {
    await prisma.aiCredential.updateMany({
      where: { userId, provider: data.provider, isDefault: true },
      data: { isDefault: false },
    });
  }

  return prisma.aiCredential.create({
    data: {
      userId,
      provider: data.provider,
      label: data.label,
      apiKeyEnc: encrypt(data.apiKey),
      isDefault,
    },
    select: { id: true, provider: true, label: true, isDefault: true, createdAt: true, updatedAt: true },
  });
}

export async function updateAiCredential(
  userId: string,
  credentialId: string,
  data: { label?: string; apiKey?: string; isDefault?: boolean }
) {
  const credential = await prisma.aiCredential.findFirst({
    where: { id: credentialId, userId },
  });
  if (!credential) return null;

  // Exactly-one-default rule per §6
  if (data.isDefault === false) {
    // Check if this is the sole default
    const otherDefaults = await prisma.aiCredential.count({
      where: { userId, provider: credential.provider, isDefault: true, id: { not: credentialId } },
    });
    if (otherDefaults === 0 && credential.isDefault) {
      throw new SettingsError('cannot_unset_sole_default', 'Cannot unset the only default credential. Set another as default first.');
    }
  }

  // If setting as default, unset previous
  if (data.isDefault === true) {
    await prisma.aiCredential.updateMany({
      where: { userId, provider: credential.provider, isDefault: true, id: { not: credentialId } },
      data: { isDefault: false },
    });
  }

  return prisma.aiCredential.update({
    where: { id: credentialId },
    data: {
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.apiKey !== undefined ? { apiKeyEnc: encrypt(data.apiKey) } : {}),
      ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
    },
    select: { id: true, provider: true, label: true, isDefault: true, createdAt: true, updatedAt: true },
  });
}

export async function deleteAiCredential(userId: string, credentialId: string) {
  const credential = await prisma.aiCredential.findFirst({
    where: { id: credentialId, userId },
  });
  if (!credential) return { status: 404 as const };

  // 409 if referenced by any run
  const referencedRun = await prisma.enrichmentRun.findFirst({
    where: { aiCredentialId: credentialId },
    select: { id: true },
  });
  if (referencedRun) {
    return { status: 409 as const, code: 'credential_in_use', message: 'Credential is referenced by an enrichment run' };
  }

  // 409 if sole default and other credentials exist
  if (credential.isDefault) {
    const otherCount = await prisma.aiCredential.count({
      where: { userId, provider: credential.provider, id: { not: credentialId } },
    });
    if (otherCount > 0) {
      return { status: 409 as const, code: 'cannot_delete_sole_default', message: 'Set another credential as default before deleting this one' };
    }
  }

  await prisma.aiCredential.delete({ where: { id: credentialId } });
  return { status: 200 as const };
}

/**
 * Decrypt and return the API key for a credential (used by enrichment pipeline).
 */
export async function getDecryptedApiKey(credentialId: string): Promise<string> {
  const credential = await prisma.aiCredential.findUnique({
    where: { id: credentialId },
    select: { apiKeyEnc: true },
  });
  if (!credential) throw new Error('Credential not found');
  return decrypt(credential.apiKeyEnc);
}

export class SettingsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}
