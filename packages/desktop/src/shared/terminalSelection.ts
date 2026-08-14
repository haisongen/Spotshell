export function getAskAiSelection(hasSelection: boolean, selection: string): string | null {
  return hasSelection && selection.trim() ? selection : null
}
