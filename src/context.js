import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { digest, immutable } from "./canonical.js"

export class WorkspaceBridge {
  async compose(workingDirectory, runtime) {
    const url = pathToFileURL(join(workingDirectory, "context.ts"))
    url.searchParams.set("turn", digest(runtime))
    const module = await import(url.href)
    if (typeof module.default !== "function") throw new Error("context.ts must export a default function")

    const messages = await module.default(
      Object.freeze({
        ...structuredClone(runtime),
        read: (path) => readWorkspaceFile(workingDirectory, path),
      }),
    )
    if (!Array.isArray(messages) || messages.some((message) => !validMessage(message))) {
      throw new Error("context.ts must return ordered role/content messages")
    }
    return immutable(structuredClone(messages))
  }
}

async function readWorkspaceFile(root, path) {
  if (!path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid context path: ${path}`)
  }
  return readFile(join(root, path), "utf8")
}

function validMessage(message) {
  return (
    message &&
    (message.role === "system" || message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  )
}
