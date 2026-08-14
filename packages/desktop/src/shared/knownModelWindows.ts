/** Known model context-window prefills for the settings form. */
const KNOWN_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  o1: 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'deepseek-chat': 65_536,
  'deepseek-reasoner': 65_536,
  'qwen-plus': 131_072,
  'qwen-turbo': 131_072,
  'qwen-max': 32_768,
  'gemini-1.5-pro': 1_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
})

export function lookupKnownModelContextWindow(model?: string): number | undefined {
  if (!model) return undefined
  const key = model.trim().toLocaleLowerCase('en-US')
  if (!key) return undefined
  return KNOWN_MODEL_CONTEXT_WINDOWS[key]
}
