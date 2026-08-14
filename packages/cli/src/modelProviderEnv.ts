import type { AgentConfig, ModelProviderId } from '@spotshell/core';

export interface CliModelConfig extends AgentConfig {
  provider: ModelProviderId;
  model: string;
}

export function parseModelProviderEnv(env: NodeJS.ProcessEnv): CliModelConfig {
  const rawProvider = env['SPOTSHELL_MODEL_PROVIDER']?.trim().toLowerCase() || 'openai';
  if (rawProvider !== 'openai' && rawProvider !== 'anthropic') {
    throw new Error(
      `Invalid SPOTSHELL_MODEL_PROVIDER: ${rawProvider}. Expected openai or anthropic.`,
    );
  }

  if (rawProvider === 'anthropic') {
    return {
      provider: 'anthropic',
      apiKey: clean(env['ANTHROPIC_API_KEY']),
      baseURL: clean(env['ANTHROPIC_BASE_URL']),
      model: clean(env['ANTHROPIC_MODEL']) || 'claude-sonnet-4-5',
    };
  }
  return {
    provider: 'openai',
    apiKey: clean(env['OPENAI_API_KEY']),
    baseURL: clean(env['OPENAI_BASE_URL']),
    model: clean(env['OPENAI_MODEL']) || 'gpt-4o-mini',
  };
}

function clean(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
