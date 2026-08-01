import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { HarnessCheckpoint } from "./adapter.ts"
import { readCodexTurn } from "./codex.ts"

export async function readHarnessTurn(
  checkpoint: HarnessCheckpoint,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (checkpoint.harness === "codex") {
    return readCodexTurn(checkpoint.sessionId, checkpoint.turnId, env.CORAL_CODEX_EXECUTABLE ?? "codex")
  }
  if (checkpoint.harness === "claude-code") {
    const root = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
    return readMarkedTurn(await findSession(root, checkpoint.sessionId), checkpoint.turnId)
  }
  if (checkpoint.harness === "pi") {
    const root = env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions")
    return readMarkedTurn(await findSession(root, checkpoint.sessionId), checkpoint.turnId)
  }
  throw new Error(`Unsupported Harness trajectory: ${checkpoint.harness}`)
}

async function findSession(root: string, sessionId: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      try {
        return await findSession(path, sessionId)
      } catch (error) {
        if (!isUnavailable(error)) throw error
      }
    } else if (entry.isFile() && entry.name.endsWith(".jsonl") && basename(entry.name, ".jsonl").endsWith(sessionId)) {
      return path
    }
  }
  throw unavailable(`session ${sessionId}`)
}

async function readMarkedTurn(path: string, turnId: string): Promise<unknown[]> {
  const source = await readFile(path, "utf8")
  const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown)
  const marker = `<coral-turn id="${turnId}">`
  const start = records.findIndex((record) => contains(record, marker))
  if (start < 0) throw unavailable(`turn ${turnId}`)
  const next = records.findIndex((record, index) =>
    index > start && contains(record, "<coral-turn id=\"")
  )
  return records.slice(start, next < 0 ? undefined : next)
}

function contains(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text)
  if (Array.isArray(value)) return value.some((item) => contains(item, text))
  return Boolean(value && typeof value === "object" && Object.values(value).some((item) => contains(item, text)))
}

function unavailable(subject: string): Error {
  return Object.assign(new Error(`Harness trajectory is unavailable: ${subject}`), { code: "TRAJECTORY_UNAVAILABLE" })
}

function isUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "TRAJECTORY_UNAVAILABLE")
}
