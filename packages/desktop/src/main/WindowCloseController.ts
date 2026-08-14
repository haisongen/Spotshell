export interface WindowCloseControllerOptions {
  activeConnectionCount: () => number
  confirmClose: (activeCount: number) => Promise<boolean>
  closeAll: () => void
  completeClose: () => void
}

export class WindowCloseController {
  private allowClose = false
  private confirmation: Promise<void> | null = null
  private cleanedUp = false

  constructor(private readonly options: WindowCloseControllerOptions) {}

  requestClose(): boolean {
    if (this.allowClose) return false
    if (!this.confirmation) {
      this.confirmation = this.resolveCloseRequest().finally(() => {
        this.confirmation = null
      })
    }
    return true
  }

  private async resolveCloseRequest(): Promise<void> {
    const activeCount = this.options.activeConnectionCount()
    if (activeCount > 0) {
      let confirmed = false
      try {
        confirmed = await this.options.confirmClose(activeCount)
      } catch {
        return
      }
      if (!confirmed) return
    }

    this.allowClose = true
    if (!this.cleanedUp) {
      this.cleanedUp = true
      this.options.closeAll()
    }
    this.options.completeClose()
  }
}
