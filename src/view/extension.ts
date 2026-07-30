import type { LedgerEvent } from "../core/ledger/ledger.ts"

export interface ViewContext {
  events: readonly LedgerEvent[]
}

export interface ViewResponse {
  contentType: string
  body: string | Uint8Array
}

export interface ViewExtension {
  plugin: string
  title: string
  render(): string | Promise<string>
  read?(resource: string, input: URLSearchParams, context: ViewContext): ViewResponse | Promise<ViewResponse>
  handle?(action: string, input: URLSearchParams): void | Promise<void>
}

export interface ViewExtensionLink {
  plugin: string
  title: string
}
