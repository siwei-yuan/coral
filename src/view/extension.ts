export interface ViewExtension {
  plugin: string
  title: string
  render(): string | Promise<string>
  handle?(action: string, input: URLSearchParams): void | Promise<void>
}

export interface ViewExtensionLink {
  plugin: string
  title: string
}
