export interface PluginExecutable {
  id: string
  executable: string
  env?: Record<string, string>
}
