/**
 * ContextAssembler estimates and allocates model context by configured window.
 * Token counts are always estimates until an exact tokenizer is known.
 */

export type ContextSlotId =
  | 'system'
  | 'environment'
  | 'hostNotes'
  | 'guidance'
  | 'catalog'
  | 'reference'
  | 'userQuotes'
  | 'terminal'
  | 'chat'
  | 'compactionSummary';

export type GuidanceSourceLayer =
  | 'safety'
  | 'userRequest'
  | 'sessionPinned'
  | 'environmentAlways'
  | 'dynamic';

export interface GuidanceRule {
  id: string;
  text: string;
  sourceLayer: GuidanceSourceLayer;
  /** Stable user-visible order within the same layer (lower first). */
  order: number;
  moduleId?: string;
  moduleName?: string;
  revision?: number;
  relativePath?: string;
}

export interface GuidanceConflict {
  left: GuidanceRule;
  right: GuidanceRule;
}

export interface ContextSlotUsage {
  id: ContextSlotId;
  estimatedTokens: number;
  shareOfInputBudget: number;
  /** Always true while SpotShell uses a generic estimator. */
  estimated: true;
}

export interface ProviderTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ContextAssemblerInput {
  contextWindowTokens: number;
  system: string;
  tools?: string;
  currentRequest: string;
  approvalState?: string;
  environment?: string;
  hostNotes?: string;
  guidance?: readonly GuidanceRule[];
  catalog?: string;
  reference?: string;
  /** Explicit user quotes of older context fragments. */
  userQuotes?: string;
  terminal?: string;
  chat?: string;
  compactionSummary?: string;
}

export interface AssembledContextContent {
  system: string;
  tools?: string;
  currentRequest: string;
  approvalState?: string;
  environment?: string;
  hostNotes?: string;
  guidance?: string;
  catalog?: string;
  reference?: string;
  userQuotes?: string;
  terminal?: string;
  chat?: string;
  compactionSummary?: string;
}

export interface ContextAssemblyResult {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  availableInputBudget: number;
  usedInputTokens: number;
  /** Token budget available for chat history after higher-priority slots. */
  chatBudgetTokens: number;
  slots: ContextSlotUsage[];
  includedGuidance: GuidanceRule[];
  omittedGuidance: GuidanceRule[];
  conflicts: GuidanceConflict[];
  assembled: AssembledContextContent;
  /** Historical estimate; never rewritten by later provider usage. */
  estimated: true;
  /**
   * Optional later-attached provider usage for display/calibration only.
   * Must not mutate {@link usedInputTokens} or slot estimates.
   */
  providerUsage?: ProviderTokenUsage;
}

const LAYER_ORDER: readonly GuidanceSourceLayer[] = [
  'safety',
  'userRequest',
  'sessionPinned',
  'environmentAlways',
  'dynamic',
] as const;

const LAYER_RANK = Object.fromEntries(
  LAYER_ORDER.map((layer, index) => [layer, index]),
) as Record<GuidanceSourceLayer, number>;

/** Soft-slot fill priority after hard-protected content is reserved. */
const SOFT_SLOT_ORDER: readonly Exclude<
  ContextSlotId,
  'system' | 'guidance'
>[] = [
  'environment',
  'hostNotes',
  'userQuotes',
  'catalog',
  'reference',
  'compactionSummary',
  'terminal',
  'chat',
] as const;

export function estimateTextTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function computeOutputReserveTokens(contextWindowTokens: number): number {
  return clamp(Math.floor(contextWindowTokens * 0.2), 1_024, 8_192);
}

export function computeSafetyReserveTokens(contextWindowTokens: number): number {
  return clamp(Math.floor(contextWindowTokens * 0.05), 256, 2_048);
}

export function assembleModelContext(input: ContextAssemblerInput): ContextAssemblyResult {
  const contextWindowTokens = Math.max(1, Math.floor(input.contextWindowTokens));
  const outputReserveTokens = computeOutputReserveTokens(contextWindowTokens);
  const safetyReserveTokens = computeSafetyReserveTokens(contextWindowTokens);
  const availableInputBudget = Math.max(
    0,
    contextWindowTokens - outputReserveTokens - safetyReserveTokens,
  );

  // Hard-protected content cannot be squeezed out by user knowledge.
  const system = input.system;
  const tools = emptyToUndefined(input.tools);
  const currentRequest = input.currentRequest;
  const approvalState = emptyToUndefined(input.approvalState);
  const hardTokens =
    estimateTextTokens(system)
    + estimateTextTokens(tools)
    + estimateTextTokens(currentRequest)
    + estimateTextTokens(approvalState);

  let remaining = Math.max(0, availableInputBudget - hardTokens);

  // Guidance activation budget is a dedicated share of remaining soft budget.
  const guidanceBudget = Math.floor(remaining * 0.35);
  const orderedGuidance = sortGuidance(input.guidance ?? []);
  const { included, omitted } = selectGuidance(orderedGuidance, guidanceBudget);
  const guidanceText = included.length > 0
    ? included.map((rule) => formatGuidanceRule(rule)).join('\n\n')
    : undefined;
  const guidanceTokens = estimateTextTokens(guidanceText);
  remaining = Math.max(0, remaining - guidanceTokens);

  const soft: Partial<Record<ContextSlotId, string>> = {};
  let chatBudgetTokens = 0;
  for (const slotId of SOFT_SLOT_ORDER) {
    if (slotId === 'chat') {
      // Chat receives whatever remains after higher-priority soft slots.
      chatBudgetTokens = remaining;
    }
    const raw = emptyToUndefined(input[slotId as keyof ContextAssemblerInput] as string | undefined);
    if (!raw) {
      if (slotId === 'chat') remaining = 0;
      continue;
    }
    const tokens = estimateTextTokens(raw);
    if (tokens <= remaining) {
      soft[slotId] = raw;
      remaining -= tokens;
      continue;
    }
    // Chat, terminal and userQuotes may be truncated to fit; other soft slots are omitted whole.
    if (slotId === 'chat' || slotId === 'terminal' || slotId === 'userQuotes') {
      const trimmed = trimTextToTokenBudget(raw, remaining);
      if (trimmed) {
        soft[slotId] = trimmed;
        remaining = Math.max(0, remaining - estimateTextTokens(trimmed));
      } else {
        remaining = 0;
      }
    }
  }

  const assembled: AssembledContextContent = {
    system,
    ...(tools ? { tools } : {}),
    currentRequest,
    ...(approvalState ? { approvalState } : {}),
    ...(soft.environment ? { environment: soft.environment } : {}),
    ...(soft.hostNotes ? { hostNotes: soft.hostNotes } : {}),
    ...(guidanceText ? { guidance: guidanceText } : {}),
    ...(soft.catalog ? { catalog: soft.catalog } : {}),
    ...(soft.reference ? { reference: soft.reference } : {}),
    ...(soft.userQuotes ? { userQuotes: soft.userQuotes } : {}),
    ...(soft.terminal ? { terminal: soft.terminal } : {}),
    ...(soft.chat ? { chat: soft.chat } : {}),
    ...(soft.compactionSummary ? { compactionSummary: soft.compactionSummary } : {}),
  };

  const slotTokens: Record<ContextSlotId, number> = {
    system: estimateTextTokens(assembled.system) + estimateTextTokens(assembled.tools)
      + estimateTextTokens(assembled.currentRequest) + estimateTextTokens(assembled.approvalState),
    environment: estimateTextTokens(assembled.environment),
    hostNotes: estimateTextTokens(assembled.hostNotes),
    guidance: estimateTextTokens(assembled.guidance),
    catalog: estimateTextTokens(assembled.catalog),
    reference: estimateTextTokens(assembled.reference),
    userQuotes: estimateTextTokens(assembled.userQuotes),
    terminal: estimateTextTokens(assembled.terminal),
    chat: estimateTextTokens(assembled.chat),
    compactionSummary: estimateTextTokens(assembled.compactionSummary),
  };

  // Report system alone without folding tools/request into other slots for the meter.
  const meterTokens: Record<ContextSlotId, number> = {
    system: estimateTextTokens(assembled.system)
      + estimateTextTokens(assembled.tools)
      + estimateTextTokens(assembled.approvalState),
    environment: slotTokens.environment,
    hostNotes: slotTokens.hostNotes,
    guidance: slotTokens.guidance,
    catalog: slotTokens.catalog,
    reference: slotTokens.reference,
    userQuotes: slotTokens.userQuotes,
    terminal: slotTokens.terminal,
    chat: slotTokens.chat + estimateTextTokens(assembled.currentRequest),
    compactionSummary: slotTokens.compactionSummary,
  };

  const usedInputTokens = Object.values(meterTokens).reduce((sum, value) => sum + value, 0);
  const slots: ContextSlotUsage[] = (
    [
      'system',
      'environment',
      'hostNotes',
      'guidance',
      'catalog',
      'reference',
      'userQuotes',
      'terminal',
      'chat',
      'compactionSummary',
    ] as const
  ).map((id) => ({
    id,
    estimatedTokens: meterTokens[id],
    shareOfInputBudget: availableInputBudget > 0
      ? meterTokens[id] / availableInputBudget
      : 0,
    estimated: true as const,
  }));

  return {
    contextWindowTokens,
    outputReserveTokens,
    safetyReserveTokens,
    availableInputBudget,
    usedInputTokens,
    chatBudgetTokens,
    slots,
    includedGuidance: included,
    omittedGuidance: omitted,
    conflicts: detectObviousConflicts(included),
    assembled,
    estimated: true,
  };
}

/**
 * Attach provider-reported usage for display only. Does not rewrite estimates.
 */
export function attachProviderUsage(
  assembly: ContextAssemblyResult,
  providerUsage: ProviderTokenUsage,
): ContextAssemblyResult {
  return {
    ...assembly,
    providerUsage: { ...providerUsage },
  };
}

export function sortGuidance(rules: readonly GuidanceRule[]): GuidanceRule[] {
  return [...rules].sort((left, right) => {
    const layerDelta = LAYER_RANK[left.sourceLayer] - LAYER_RANK[right.sourceLayer];
    if (layerDelta !== 0) return layerDelta;
    if (left.order !== right.order) return left.order - right.order;
    return left.id.localeCompare(right.id, 'en-US');
  });
}

/**
 * Prefix selection preserves layer priority: once a higher-priority rule does not
 * fit, remaining lower-priority rules are omitted rather than back-filled.
 */
function selectGuidance(
  ordered: readonly GuidanceRule[],
  budgetTokens: number,
): { included: GuidanceRule[]; omitted: GuidanceRule[] } {
  const included: GuidanceRule[] = [];
  const omitted: GuidanceRule[] = [];
  let used = 0;
  let packing = true;
  for (const rule of ordered) {
    if (!packing) {
      omitted.push(rule);
      continue;
    }
    const tokens = estimateTextTokens(formatGuidanceRule(rule));
    if (used + tokens <= budgetTokens) {
      included.push(rule);
      used += tokens;
    } else {
      omitted.push(rule);
      packing = false;
    }
  }
  return { included, omitted };
}

function formatGuidanceRule(rule: GuidanceRule): string {
  const source = [
    rule.moduleName,
    rule.relativePath,
    rule.revision !== undefined ? `rev ${rule.revision}` : undefined,
  ].filter(Boolean).join(' · ');
  return source ? `[${source}]\n${rule.text}` : rule.text;
}

/**
 * Detect obvious same-layer conflicts via simple opposing directive cues.
 * Not a full NLU system — surfaces clear never/always style opposites.
 */
export function detectObviousConflicts(rules: readonly GuidanceRule[]): GuidanceConflict[] {
  const conflicts: GuidanceConflict[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const left = rules[i]!;
      const right = rules[j]!;
      if (left.sourceLayer !== right.sourceLayer) continue;
      if (areObviouslyConflicting(left.text, right.text)) {
        conflicts.push({ left, right });
      }
    }
  }
  return conflicts;
}

function areObviouslyConflicting(leftText: string, rightText: string): boolean {
  const left = normalizeConflictText(leftText);
  const right = normalizeConflictText(rightText);
  if (!left || !right) return false;

  const pairs: Array<[RegExp, RegExp]> = [
    [/\bnever\b/, /\balways\b/],
    [/\bdo not\b/, /\balways\b/],
    [/\bmust not\b/, /\bmust\b/],
    [/\b禁止\b/, /\b必须\b/],
    [/\b不要\b/, /\b始终\b/],
  ];

  for (const [neg, pos] of pairs) {
    if ((neg.test(left) && pos.test(right)) || (neg.test(right) && pos.test(left))) {
      // Require overlapping topical tokens so unrelated rules do not collide.
      if (shareTopicTokens(left, right)) return true;
    }
  }
  return false;
}

function normalizeConflictText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US');
}

function shareTopicTokens(left: string, right: string): boolean {
  const tokenize = (value: string): Set<string> => new Set(
    (value.match(/[\p{L}\p{N}]{3,}/gu) ?? [])
      .filter((token) => !STOP_WORDS.has(token)),
  );
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared >= 1;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'when', 'then',
  'always', 'never', 'must', 'not', 'without', 'error', 'immediately',
  'approval', 'before', 'after', 'into', 'onto',
]);

function trimTextToTokenBudget(text: string, budgetTokens: number): string | undefined {
  if (budgetTokens <= 0) return undefined;
  const maxChars = budgetTokens * 4;
  if (text.length <= maxChars) return text;
  if (maxChars < 32) return undefined;
  // Keep the newest tail for terminal/chat evidence.
  return text.slice(text.length - maxChars);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
