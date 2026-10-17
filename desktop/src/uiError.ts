import type { Params } from '@vault/i18n'

/** An error whose message is a catalog key, rendered by the UI in the active locale. */
export class UiError extends Error {
  constructor(readonly key: string, readonly params?: Params) {
    super(key)
    this.name = 'UiError'
  }
}
