export function terminalInputForCommand(command: string, run: boolean): string {
  const text = command.replace(/\r?\n$/, '')
  return run ? `${text}\n` : text
}

export function appendTerminalPrefill(draft: string, selection: string): string {
  const quoted = '```\n' + selection.replace(/\r\n/g, '\n').trimEnd() + '\n```\n'
  return draft ? `${draft}\n${quoted}` : quoted
}
