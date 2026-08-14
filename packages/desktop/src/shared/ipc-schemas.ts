import { z } from 'zod'

const nonEmptyString = z.string().min(1)
const port = z.number().int().min(1).max(65535)

export const clipboardTextSchema = z.string()

export const appMenuPopupRequestSchema = z.object({
  menuId: z.enum(['file', 'edit', 'view', 'window', 'help']),
  x: z.number().int().min(0).max(10_000),
  y: z.number().int().min(0).max(10_000),
}).strict()

const knowledgeIdSchema = z.string().uuid().refine(
  (id) => id === id.toLocaleLowerCase('en-US'),
  { message: 'Knowledge module ID must be a canonical lowercase UUID' }
)

export const knowledgeCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict()

export const knowledgeIdRequestSchema = z.object({
  id: knowledgeIdSchema,
}).strict()

export const knowledgeGlobalOnDemandRequestSchema = z.object({
  id: knowledgeIdSchema,
  authorized: z.boolean(),
}).strict()

const knowledgeFormDraftSchema = z.object({
  name: z.string().max(100),
  description: z.string().max(500),
  whenToUse: z.string().max(500),
  whenNotToUse: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(20),
  beforeGuidance: z.string().max(2 * 1024 * 1024),
  inlineGuidance: z.string().max(2 * 1024 * 1024).optional(),
  afterGuidance: z.string().max(2 * 1024 * 1024),
}).strict()

export const knowledgeDraftFormRequestSchema = z.object({
  id: knowledgeIdSchema,
  form: knowledgeFormDraftSchema,
}).strict()

export const knowledgeDraftSourceRequestSchema = z.object({
  id: knowledgeIdSchema,
  source: z.string().max(2 * 1024 * 1024),
}).strict()

const revisionNumberSchema = z.number().int().positive().max(1_000_000)
const revisionNumberListSchema = z.array(revisionNumberSchema).max(256)

const knowledgeRevisionProtectionSchema = {
  agentActiveRevisions: revisionNumberListSchema.optional(),
  proposalTargetRevisions: revisionNumberListSchema.optional(),
  recoveryRequiredRevisions: revisionNumberListSchema.optional(),
}

export const knowledgeListRevisionsRequestSchema = z.object({
  id: knowledgeIdSchema,
  ...knowledgeRevisionProtectionSchema,
}).strict()

export const knowledgeCompareRevisionsRequestSchema = z.object({
  id: knowledgeIdSchema,
  leftRevision: revisionNumberSchema,
  rightRevision: revisionNumberSchema,
}).strict()

export const knowledgeRestoreRevisionRequestSchema = z.object({
  id: knowledgeIdSchema,
  revision: revisionNumberSchema,
}).strict()

export const knowledgeRevisionCleanupRequestSchema = z.object({
  id: knowledgeIdSchema,
  revisions: revisionNumberListSchema.min(1),
  ...knowledgeRevisionProtectionSchema,
}).strict()

export const knowledgePreviewDeleteRequestSchema = knowledgeIdRequestSchema
export const knowledgeMoveToTrashRequestSchema = knowledgeIdRequestSchema
export const environmentPreviewDeleteRequestSchema = knowledgeIdRequestSchema
export const environmentMoveToTrashRequestSchema = knowledgeIdRequestSchema
export const trashIdRequestSchema = knowledgeIdRequestSchema

export const trashPermanentDeleteRequestSchema = z.object({
  id: knowledgeIdSchema,
  agentActiveRevisions: revisionNumberListSchema.optional(),
}).strict()

export const environmentCreateRequestSchema = knowledgeCreateRequestSchema

export const environmentIdRequestSchema = knowledgeIdRequestSchema

const environmentFormDraftSchema = z.object({
  name: z.string().max(100),
  description: z.string().max(500),
  tags: z.array(z.string().max(50)).max(20),
  always: z.array(knowledgeIdSchema).max(64),
  onDemand: z.array(knowledgeIdSchema).max(64),
  body: z.string().max(2 * 1024 * 1024),
}).strict()

export const environmentDraftFormRequestSchema = z.object({
  id: knowledgeIdSchema,
  form: environmentFormDraftSchema,
}).strict()

export const environmentDraftSourceRequestSchema = knowledgeDraftSourceRequestSchema

const managedRelativePathSchema = z.string().trim().min(1).max(240)

export const managedFilesIdRequestSchema = knowledgeIdRequestSchema

export const managedFilesCreateRequestSchema = z.object({
  id: knowledgeIdSchema,
  relativePath: managedRelativePathSchema,
  content: z.string().max(2 * 1024 * 1024).optional(),
}).strict()

export const managedFilesPathRequestSchema = z.object({
  id: knowledgeIdSchema,
  relativePath: managedRelativePathSchema,
}).strict()

export const managedFilesSaveRequestSchema = z.object({
  id: knowledgeIdSchema,
  relativePath: managedRelativePathSchema,
  content: z.string().max(2 * 1024 * 1024),
}).strict()

export const managedFilesImportRequestSchema = z.object({
  id: knowledgeIdSchema,
  relativePath: managedRelativePathSchema,
  absoluteSourcePath: z.string().trim().min(1).max(4096),
}).strict()

export const managedFilesRenameRequestSchema = z.object({
  id: knowledgeIdSchema,
  fromRelativePath: managedRelativePathSchema,
  toRelativePath: managedRelativePathSchema,
}).strict()

export const managedFilesGuidanceRequestSchema = z.object({
  id: knowledgeIdSchema,
  relativePath: managedRelativePathSchema,
  registered: z.boolean(),
}).strict()

export const knowledgeOpenObjectRootRequestSchema = knowledgeIdRequestSchema
export const knowledgeScanExternalChangesRequestSchema = knowledgeIdRequestSchema
export const knowledgePreviewExternalChangesRequestSchema = knowledgeIdRequestSchema
export const knowledgeAdoptExternalChangesRequestSchema = knowledgeIdRequestSchema
export const knowledgeDiscardExternalChangesRequestSchema = knowledgeIdRequestSchema

const packagePathSchema = z.string().trim().min(1).max(4096)

export const knowledgeExportModuleRequestSchema = z.object({
  id: knowledgeIdSchema,
  packagePath: packagePathSchema,
}).strict()

export const knowledgeImportModulePreviewRequestSchema = z.object({
  packagePath: packagePathSchema,
}).strict()

export const knowledgeImportModuleRequestSchema = z.object({
  packagePath: packagePathSchema,
  conflictResolution: z.enum(['keep-local', 'use-imported', 'import-as-copy']).optional(),
}).strict()

export const knowledgePickExportModulePathRequestSchema = z.object({
  suggestedName: z.string().trim().min(1).max(200),
}).strict()

const moduleImportConflictResolutionSchema = z.enum([
  'keep-local',
  'use-imported',
  'import-as-copy',
])

const officialSeedKeySchema = z.enum([
  'healthcheck',
  'disk-full',
  'oom',
  'service-down',
  'port-conflict',
  'cert-expiry',
  'hdfs-yarn',
])

export const knowledgePreviewRestoreSeedRequestSchema = z.object({
  seedKey: officialSeedKeySchema,
}).strict()

export const knowledgeRestoreSeedRequestSchema = z.object({
  seedKey: officialSeedKeySchema,
  conflictResolution: moduleImportConflictResolutionSchema.optional(),
  authorizeGlobalOnDemand: z.boolean().optional(),
}).strict()

export const knowledgeRestoreAllSeedsRequestSchema = z.object({
  conflictResolution: moduleImportConflictResolutionSchema.optional(),
  authorizeGlobalOnDemand: z.boolean().optional(),
}).strict()

export const environmentExportPreviewRequestSchema = knowledgeIdRequestSchema

export const environmentExportRequestSchema = z.object({
  id: knowledgeIdSchema,
  packagePath: packagePathSchema,
  mode: z.enum(['self-contained', 'definition-only']).optional(),
}).strict()

export const environmentImportPreviewRequestSchema = z.object({
  packagePath: packagePathSchema,
}).strict()

export const environmentImportRequestSchema = z.object({
  packagePath: packagePathSchema,
  environmentResolution: moduleImportConflictResolutionSchema.optional(),
  moduleResolutions: z.record(knowledgeIdSchema, moduleImportConflictResolutionSchema).optional(),
}).strict()

export const environmentPickExportPathRequestSchema = z.object({
  suggestedName: z.string().trim().min(1).max(200),
}).strict()

export const sessionIdSchema = nonEmptyString
export const hostIdSchema = nonEmptyString
export const agentClearSchema = sessionIdSchema

const sessionTitleSchema = z.string().trim().min(1).refine(
  (title) => Array.from(title).length <= 80,
  { message: 'Session title must be 80 characters or fewer' }
)

export const renameSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
  title: sessionTitleSchema,
}).strict()

export const duplicateSessionRequestSchema = renameSessionRequestSchema

export const closeSessionsRequestSchema = z.object({
  sessionIds: z.array(sessionIdSchema).max(100),
}).strict()

export const sessionEnvironmentSelectionRequestSchema = z.object({
  sessionId: sessionIdSchema,
  environmentId: knowledgeIdSchema.optional(),
  persistForHost: z.boolean(),
}).strict()

export const sessionKnowledgeModuleRequestSchema = z.object({
  sessionId: sessionIdSchema,
  moduleId: knowledgeIdSchema,
}).strict()

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const sessionApplyRevisionRequestSchema = z.object({
  sessionId: sessionIdSchema,
  objectId: z.string().min(1).max(200),
  targetRevision: z.number().int().positive(),
  targetContentHash: contentHashSchema,
}).strict()

export const sessionKeepRevisionRequestSchema = z.object({
  sessionId: sessionIdSchema,
  objectId: z.string().min(1).max(200),
  latestRevision: z.number().int().positive(),
  latestContentHash: contentHashSchema,
}).strict()

const hostFolderName = z.string().trim().min(1).max(100)
const optionalHostFolderId = z.string().trim().min(1).optional()

export const addHostFolderRequestSchema = z.object({
  name: hostFolderName,
  parentId: optionalHostFolderId,
}).strict()

export const renameHostFolderRequestSchema = z.object({
  id: z.string().trim().min(1),
  name: hostFolderName,
}).strict()

export const removeHostFolderRequestSchema = z.object({
  id: z.string().trim().min(1),
}).strict()

export const moveHostRequestSchema = z.object({
  hostId: z.string().trim().min(1),
  folderId: optionalHostFolderId,
}).strict()

export const hostConnectionTestRequestSchema = z.object({
  hostId: z.string().trim().min(1),
  draft: z.object({
    host: z.string().trim().min(1),
    port,
    username: z.string().trim().min(1),
    authMethod: z.enum(['key', 'password', 'agent']),
    privateKeyPath: nonEmptyString.optional(),
    password: nonEmptyString.optional(),
    useSavedPassword: z.boolean(),
  }).strict().optional(),
}).strict()

export const connectRequestSchema = z.object({
  hostId: nonEmptyString.optional(),
  host: nonEmptyString,
  port,
  username: nonEmptyString,
  password: z.string().optional(),
  privateKeyPath: nonEmptyString.optional(),
  useAgent: z.boolean().optional(),
  title: nonEmptyString.optional(),
})

export const agentChatQuoteSchema = z.object({
  sourceMessageId: nonEmptyString,
  sourceEpoch: z.number().int().positive(),
  role: z.enum(['user', 'assistant', 'tool']),
  createdAt: nonEmptyString,
  contentSnapshot: z.string().min(1).max(8_000),
  truncated: z.boolean().optional(),
  charRange: z.object({
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  }).optional(),
})

export const agentChatRequestSchema = z.object({
  sessionId: nonEmptyString,
  message: z.string().min(1).max(32_000),
  quotes: z.array(agentChatQuoteSchema).max(5).optional(),
})

export const agentConfirmRespondSchema = z.object({
  requestId: nonEmptyString,
  ok: z.boolean(),
})

export const hostVerifyRespondSchema = agentConfirmRespondSchema
export const noteRespondSchema = agentConfirmRespondSchema

/** `optionIndex: null` is an explicit "none of these", not a missing field. */
export const knowledgeTargetRespondSchema = z.object({
  requestId: nonEmptyString,
  optionIndex: z.number().int().min(0).max(5).nullable(),
}).strict()

export const knowledgeProposalFileChangeSchema = z.object({
  relativePath: nonEmptyString.max(240),
  before: z.string().max(200_000),
  after: z.string().max(200_000),
}).strict()

export const knowledgeProposalRespondSchema = z.object({
  requestId: nonEmptyString,
  ok: z.boolean(),
  reason: z.string().max(1000).optional(),
  terminalEvidence: z.string().max(4000).optional(),
  files: z.array(knowledgeProposalFileChangeSchema).max(20).optional(),
  promoteToGuidance: z.boolean().optional(),
}).strict()

export const agentCancelSchema = z.object({ sessionId: nonEmptyString })

export const setPolicySchema = z.object({
  sessionId: nonEmptyString,
  policy: z.enum(['readonly', 'ask', 'auto']),
})

export const termInputSchema = z.object({
  sessionId: nonEmptyString,
  data: nonEmptyString,
})

export const termResizeSchema = z.object({
  sessionId: nonEmptyString,
  cols: z.number().int().min(1).max(10_000),
  rows: z.number().int().min(1).max(10_000),
})

export const savedHostInputSchema = z.object({
  id: nonEmptyString.optional(),
  name: nonEmptyString,
  host: nonEmptyString,
  port,
  username: nonEmptyString,
  privateKeyPath: nonEmptyString.optional(),
  authMethod: z.enum(['key', 'password', 'agent']).optional(),
  password: z.string().optional(),
  notes: z.string().max(4000).optional(),
  folderId: optionalHostFolderId,
  environmentId: knowledgeIdSchema.optional(),
}).strict()

export const savedHostPatchSchema = savedHostInputSchema.partial()

export const settingsUpdateSchema = z.object({
  language: z.enum(['en', 'zh-CN']).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  recursionLimit: z.number().int().positive().optional(),
  shellIntegration: z.boolean().optional(),
  /** Default true when omitted from stored settings. */
  allowAutoContextCompaction: z.boolean().optional(),
  model: z.object({
    activeProvider: z.enum(['openai', 'anthropic']).optional(),
    provider: z.object({
      provider: z.enum(['openai', 'anthropic']),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      contextWindowTokens: z.number().int().min(4_096).max(2_000_000).nullable().optional(),
      apiKey: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict()

export const llmTestRequestSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
}).strict()
