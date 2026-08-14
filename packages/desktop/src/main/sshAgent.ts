const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

export function resolveSshAgentSocket(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const configured = env['SSH_AUTH_SOCK']?.trim()
  if (configured) return configured
  return platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : undefined
}

export function requireSshAgentSocket(): string {
  const socket = resolveSshAgentSocket()
  if (!socket) {
    throw new Error('SSH agent is unavailable: SSH_AUTH_SOCK is not set')
  }
  return socket
}
