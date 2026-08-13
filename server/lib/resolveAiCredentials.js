'use strict';

/**
 * Load the AI provider name, API key, and model for a given project.
 *
 *   const { provider, apiKey, model } = await resolveAiCredentials(userId, project);
 *
 * - `provider`     : 'claude' | 'gemini' — falls back to 'claude' if the project
 *                    has no `aiProvider` set (legacy projects).
 * - `apiKey`       : Decrypted key from the vault for the matching provider
 *                    (`<provider>.apiKey` secret name). `null` if not configured.
 * - `model`        : Project user's chosen model from the Integration row, or
 *                    a sensible default for the provider.
 *
 * Every agent service expects these three values. Centralising the lookup
 * means routes don't have to know which secret name / integration type
 * corresponds to which provider.
 */

const vault = require('../services/vault');
const integrations = require('../services/integrations');
const { isValidProvider } = require('./llmProvider');

const DEFAULT_MODEL_BY_PROVIDER = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  copilot: 'copilot-gpt-4o',
};

async function resolveAiCredentials(userId, project) {
  const raw = project?.aiProvider || 'claude';
  const provider = isValidProvider(raw) ? raw.toLowerCase() : 'claude';

  if (provider === 'copilot') {
    const model = project?.aiModel || DEFAULT_MODEL_BY_PROVIDER.copilot;
    return {
      provider: 'copilot',
      apiKey: 'copilot-bridge-active',
      model,
      integration: { status: 'valid', config: { model } },
    };
  }

  const secretName = `${provider}.apiKey`;
  const integrationType = provider;

  const [apiKey, integration] = await Promise.all([
    vault.get(userId, secretName),
    integrations.get(userId, integrationType),
  ]);

  const model = integration?.config?.model || DEFAULT_MODEL_BY_PROVIDER[provider];
  return { provider, apiKey, model, integration };
}

module.exports = { resolveAiCredentials, DEFAULT_MODEL_BY_PROVIDER };
