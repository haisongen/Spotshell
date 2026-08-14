import { createHash } from 'node:crypto';
import { SPACE_SCHEMA_VERSION } from './limits.js';
import {
  buildKnowledgeModulePackage,
  serializeKnowledgeModulePackage,
  type BuiltKnowledgeModulePackage,
  type KnowledgeModulePackage,
} from './modulePackage.js';
import {
  parseSpaceDocument,
  serializeSpaceDocument,
  type KnowledgeSpaceMetadata,
  type SpaceDocument,
} from './spaceDocument.js';

/**
 * Health-check commands must remain classifyCommand=readonly.
 * Keep in core so seed content and the safety fuse test share one list.
 */
export const HEALTH_CHECK_COMMANDS: readonly string[] = [
  'uptime',
  'free -m',
  'df -h',
  'ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%mem | head -15',
  'ss -tlnp | head -30',
  'ip -brief addr',
  'uname -a',
];

/** Stable product keys for the seven former diagnostic scenarios (ADR-051). */
export type OfficialSeedKey =
  | 'healthcheck'
  | 'disk-full'
  | 'oom'
  | 'service-down'
  | 'port-conflict'
  | 'cert-expiry'
  | 'hdfs-yarn';

export interface OfficialSeedModuleDefinition {
  key: OfficialSeedKey;
  /** Fixed stable identity used for seed / restore / conflict detection. */
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse?: string;
  tags: readonly string[];
  /** Markdown body after YAML frontmatter (includes optional ## Guidance). */
  body: string;
}

const FORMAT_GUIDANCE = [
  '- 输出固定格式：1. 结论；2. 证据（引用你执行的命令与关键输出行）；3. 建议下一步（命令放入代码块）。',
  '- Use this fixed output format: 1. Conclusion; 2. Evidence (quote commands and key lines); 3. Suggested next steps (commands in code blocks).',
].join('\n');

/**
 * Deterministic UUIDs for official seed modules.
 * These are product-stable identities, not random drafts.
 */
export const OFFICIAL_SEED_MODULES: readonly OfficialSeedModuleDefinition[] = [
  {
    key: 'healthcheck',
    id: 'a1000000-0000-4000-8000-000000000001',
    name: '只读体检',
    description: '对 Linux 主机做一次只读健康体检，覆盖负载、内存、磁盘、进程、端口与网络。',
    whenToUse:
      'Use for general health check / 只读体检 / host overview when no specific failure is named.',
    whenNotToUse: 'Do not use when the user already named a specific disk, OOM, service, port, cert, or HDFS issue.',
    tags: ['diagnostics', 'healthcheck', 'linux', 'readonly'],
    body: [
      '# 只读体检',
      '',
      '对当前服务器做一次只读体检。下列命令全部只读，可直接执行。',
      '',
      '## Guidance',
      '',
      '- 按顺序执行「参考：体检命令」中的全部只读命令。',
      '- 结论部分给出整体健康状况，并逐项标注 正常/异常（OK / abnormal）。',
      '- 只做只读诊断，不要修改配置、不要删除文件、不要 kill 进程。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：体检命令',
      '',
      '```text',
      ...HEALTH_CHECK_COMMANDS,
      '```',
      '',
    ].join('\n'),
  },
  {
    key: 'disk-full',
    id: 'a1000000-0000-4000-8000-000000000002',
    name: '磁盘满排查',
    description: '定位磁盘使用率过高的挂载点、目录与已删除但仍占用空间的打开文件。',
    whenToUse:
      'Use for disk full / 磁盘满 / no space left / high disk usage / df or du investigations.',
    tags: ['diagnostics', 'disk', 'storage', 'linux'],
    body: [
      '# 磁盘满排查',
      '',
      '排查服务器磁盘空间问题。',
      '',
      '## Guidance',
      '',
      '- 先用 `df -h` 找到使用率最高的挂载点。',
      '- 再用 `du` 逐层定位占用最大的目录（一次只深入一层）。',
      '- 检查是否有已删除但仍被进程占用的大文件（`lsof | grep deleted`）。',
      '- 只做只读操作，不要删除任何文件；清理命令放在建议里让用户确认。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：常用只读命令',
      '',
      '- `df -h`',
      '- `du -h --max-depth=1 <path> | sort -h`',
      '- `lsof | grep deleted`',
      '',
    ].join('\n'),
  },
  {
    key: 'oom',
    id: 'a1000000-0000-4000-8000-000000000003',
    name: 'OOM/内存排查',
    description: '检查内存与 swap、高内存进程，以及内核 OOM killer 记录。',
    whenToUse:
      'Use for OOM / out of memory / 内存不足 / swap pressure / oom-killer investigations.',
    tags: ['diagnostics', 'memory', 'oom', 'linux'],
    body: [
      '# OOM/内存排查',
      '',
      '排查服务器内存问题。',
      '',
      '## Guidance',
      '',
      '- 用 `free -m` 看总体内存与 swap。',
      '- 用 `ps` 按 `%mem` 排序找出占用最高的进程。',
      '- 在内核日志中搜索 OOM killer 记录（dmesg 或 journalctl 中的 "Out of memory" / "oom-killer"）。',
      '- 只做只读诊断；处置命令放在建议里。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：常用只读命令',
      '',
      '- `free -m`',
      '- `ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%mem | head -20`',
      '- `dmesg -T | grep -iE "out of memory|oom-killer"`',
      '- `journalctl -k | grep -iE "out of memory|oom-killer"`',
      '',
    ].join('\n'),
  },
  {
    key: 'service-down',
    id: 'a1000000-0000-4000-8000-000000000004',
    name: '服务起不来',
    description: '用 systemctl 与 journalctl 只读诊断服务无法启动或反复失败的原因。',
    whenToUse:
      'Use when a systemd service will not start / 服务起不来 / unit failed / service inactive.',
    tags: ['diagnostics', 'systemd', 'service', 'linux'],
    body: [
      '# 服务起不来',
      '',
      '诊断 systemd 服务启动失败。',
      '',
      '## Guidance',
      '',
      '- 先确认要排查的服务名（若终端上下文已能看出则直接用）。',
      '- `systemctl status <服务>` 看状态与最近日志。',
      '- `journalctl -u <服务> -n 50` 看启动失败原因。',
      '- 必要时只读检查服务配置文件以定位错误。',
      '- 只做只读诊断，修复命令放在建议里让用户确认。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：常用只读命令',
      '',
      '- `systemctl status <service>`',
      '- `journalctl -u <service> -n 50 --no-pager`',
      '- `systemctl cat <service>`',
      '',
    ].join('\n'),
  },
  {
    key: 'port-conflict',
    id: 'a1000000-0000-4000-8000-000000000005',
    name: '端口占用',
    description: '查找占用指定端口的监听进程及其启动命令。',
    whenToUse:
      'Use for port in use / 端口占用 / address already in use / bind failure on a TCP port.',
    tags: ['diagnostics', 'network', 'port', 'linux'],
    body: [
      '# 端口占用',
      '',
      '排查端口被占用问题。',
      '',
      '## Guidance',
      '',
      '- 先确认要排查的端口号（若终端上下文已能看出则直接用）。',
      '- 用 `ss -tlnp` 找到监听该端口的进程。',
      '- 用 `ps` 确认进程详情与启动命令。',
      '- 只做只读诊断，不要 kill 任何进程；处置命令放在建议里。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：常用只读命令',
      '',
      '- `ss -tlnp`',
      '- `ss -tlnp | grep :<port>`',
      '- `ps -fp <pid>`',
      '',
    ].join('\n'),
  },
  {
    key: 'cert-expiry',
    id: 'a1000000-0000-4000-8000-000000000006',
    name: '证书过期检查',
    description: '检查远程或本地 TLS/X.509 证书的有效期。',
    whenToUse:
      'Use for certificate expiry / 证书过期 / TLS cert dates / SSL notAfter checks.',
    tags: ['diagnostics', 'tls', 'certificate', 'security'],
    body: [
      '# 证书过期检查',
      '',
      '检查证书有效期。',
      '',
      '## Guidance',
      '',
      '- 先确认域名/端口或本地证书文件路径（若终端上下文已能看出则直接用）。',
      '- 远程证书：`openssl s_client -connect` 取证书后经 `openssl x509 -noout -dates`。',
      '- 本地证书文件：`openssl x509 -noout -dates -in <path>`。',
      '- 只做只读检查；续期或替换步骤放在建议里。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：常用只读命令',
      '',
      '- `echo | openssl s_client -connect host:443 2>/dev/null | openssl x509 -noout -dates`',
      '- `openssl x509 -noout -dates -in <path>`',
      '',
    ].join('\n'),
  },
  {
    key: 'hdfs-yarn',
    id: 'a1000000-0000-4000-8000-000000000007',
    name: 'HDFS/Yarn 专项',
    description: '从当前节点只读查看 HDFS 容量/DataNode 状态与 Yarn 运行中应用。',
    whenToUse:
      'Use for HDFS / Yarn / Hadoop cluster health, DataNode capacity, or application list checks.',
    tags: ['diagnostics', 'hadoop', 'hdfs', 'yarn'],
    body: [
      '# HDFS/Yarn 专项',
      '',
      '排查本机可见的 Hadoop 集群状态。',
      '',
      '## Guidance',
      '',
      '- `hdfs dfsadmin -report` 看 DataNode 与容量；若无权限则 `hdfs dfs -df -h`。',
      '- `yarn application -list` 看运行中的应用。',
      '- 记住：stderr 里的 Java WARN/GSS 日志在 exit_code=0 时不算失败。',
      '- 只做只读诊断；变更集群状态的命令放在建议里。',
      FORMAT_GUIDANCE,
      '',
      '## 参考：常用只读命令',
      '',
      '- `hdfs dfsadmin -report`',
      '- `hdfs dfs -df -h`',
      '- `yarn application -list`',
      '',
    ].join('\n'),
  },
];

const SEED_BY_KEY = new Map(OFFICIAL_SEED_MODULES.map((seed) => [seed.key, seed]));
const SEED_BY_ID = new Map(OFFICIAL_SEED_MODULES.map((seed) => [seed.id, seed]));

export function getOfficialSeedByKey(key: string): OfficialSeedModuleDefinition | undefined {
  return SEED_BY_KEY.get(key as OfficialSeedKey);
}

export function getOfficialSeedById(id: string): OfficialSeedModuleDefinition | undefined {
  return SEED_BY_ID.get(id);
}

export function isOfficialSeedId(id: string): boolean {
  return SEED_BY_ID.has(id);
}

export function officialSeedDocument(seed: OfficialSeedModuleDefinition): SpaceDocument {
  const metadata: KnowledgeSpaceMetadata = {
    schema_version: SPACE_SCHEMA_VERSION,
    id: seed.id,
    kind: 'knowledge',
    name: seed.name,
    description: seed.description,
    when_to_use: seed.whenToUse,
    ...(seed.whenNotToUse ? { when_not_to_use: seed.whenNotToUse } : {}),
    tags: [...seed.tags],
  };
  const document = parseSpaceDocument(serializeSpaceDocument({
    metadata,
    body: seed.body.endsWith('\n') ? seed.body : `${seed.body}\n`,
  }));
  return document;
}

/** Content-address hash matching loadSpaceObject / package materialization. */
export function hashSeedModuleFiles(
  files: ReadonlyArray<{ relativePath: string; content: string }>,
  document: SpaceDocument,
): string {
  const ordered = [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en-US'),
  );
  const hash = createHash('sha256');
  for (const file of ordered) {
    const content = file.relativePath === 'SPACE.md'
      ? serializeSpaceDocument(document)
      : normalizeSeedText(file.content);
    updateFramed(hash, file.relativePath);
    updateFramed(hash, content);
  }
  return hash.digest('hex');
}

export function buildOfficialSeedPackage(
  seed: OfficialSeedModuleDefinition,
  exportedAt: string = new Date().toISOString(),
): BuiltKnowledgeModulePackage {
  const document = officialSeedDocument(seed);
  const files = [{
    relativePath: 'SPACE.md',
    content: serializeSpaceDocument(document),
  }];
  const contentHash = hashSeedModuleFiles(files, document);
  return buildKnowledgeModulePackage({
    files,
    contentHash,
    exportedAt,
  });
}

export function serializeOfficialSeedPackage(
  seed: OfficialSeedModuleDefinition,
  exportedAt: string = new Date().toISOString(),
): { package: KnowledgeModulePackage; contentHash: string; text: string } {
  const built = buildOfficialSeedPackage(seed, exportedAt);
  return {
    package: built.package,
    contentHash: built.contentHash,
    text: serializeKnowledgeModulePackage(built.package),
  };
}

function normalizeSeedText(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').trimEnd();
  return normalized ? `${normalized}\n` : '';
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}
