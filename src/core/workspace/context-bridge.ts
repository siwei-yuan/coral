import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { digest, immutable } from "../canonical.ts"

export interface ContextMessage {
  role: "system" | "user" | "assistant"
  content: string
}

type ContextRuntime = Record<string, unknown>

interface ContextModuleInput extends ContextRuntime {
  read(path: string): Promise<string>
}

type ContextComposer = (input: ContextModuleInput) => Promise<ContextMessage[]> | ContextMessage[]

export class WorkspaceBridge {
  async compose(workingDirectory: string, runtime: ContextRuntime): Promise<ContextMessage[]> {
    const url = pathToFileURL(join(workingDirectory, "context.ts"))
    url.searchParams.set("turn", digest(runtime))
    const module = (await import(url.href)) as { default?: unknown }
    if (typeof module.default !== "function") throw new Error("context.ts must export a default function")

    const compose = module.default as ContextComposer
    const messages = await compose(
      Object.freeze({
        ...structuredClone(runtime),
        read: (path: string) => readWorkspaceFile(workingDirectory, path),
      }),
    )
    if (!Array.isArray(messages) || messages.some((message) => !validMessage(message))) {
      throw new Error("context.ts must return ordered role/content messages")
    }
    return immutable(structuredClone(messages))
  }
}

async function readWorkspaceFile(root: string, path: string): Promise<string> {
  if (!path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid context path: ${path}`)
  }
  return readFile(join(root, path), "utf8")
}

function validMessage(message: unknown): message is ContextMessage {
  if (!message || typeof message !== "object") return false
  const candidate = message as Partial<ContextMessage>
  return (
    (candidate.role === "system" || candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string"
  )
}
