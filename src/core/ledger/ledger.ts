import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { digest, immutable } from "../canonical.ts"

export type Scope = { kind: "active" } | { kind: "fork"; forkId: string }

export interface EventDraft {
  type: string
  schema?: string
  actor: string
  scope: Scope
  causation?: string[]
  correlation?: string
  swarmRevision?: string
  data?: unknown
  evidence?: unknown
}

export interface LedgerEvent {
  id: string
  seq: number
  type: string
  schema: string
  actor: string
  scope: Scope
  causation: string[]
  correlation?: string
  swarmRevision?: string
  data: unknown
  evidence?: unknown
  recordedAt: string
  previousHash: string | null
  hash: string
}

export class Ledger {
  #events: LedgerEvent[]
  #file: number | null
  #closed = false

  private constructor(events: LedgerEvent[] = [], file: number | null = null) {
    this.#events = events
    this.#file = file
  }

  static memory(): Ledger {
    return new Ledger()
  }

  static create(path: string): Ledger {
    const filePath = resolve(path)
    mkdirSync(dirname(filePath), { recursive: true })
    return new Ledger([], openSync(filePath, "wx"))
  }

  static open(path: string): Ledger {
    const filePath = resolve(path)
    const source = readFileSync(filePath, "utf8")
    const events = source.trim() === ""
      ? []
      : source.trimEnd().split("\n").map((line) => immutable<LedgerEvent>(JSON.parse(line)))
    const ledger = new Ledger(events)
    if (!ledger.verify()) throw new Error(`Ledger verification failed: ${filePath}`)
    ledger.#file = openSync(filePath, "a")
    return ledger
  }

  append(draft: EventDraft): LedgerEvent {
    if (this.#closed) throw new Error("Ledger is closed")
    validateDraft(draft)
    const seq = this.#events.length + 1
    const previousHash = this.#events.at(-1)?.hash ?? null
    const body = {
      seq,
      type: draft.type,
      schema: draft.schema ?? `${draft.type}@1`,
      actor: draft.actor,
      scope: draft.scope,
      causation: [...(draft.causation ?? [])],
      ...(draft.correlation ? { correlation: draft.correlation } : {}),
      ...(draft.swarmRevision ? { swarmRevision: draft.swarmRevision } : {}),
      data: draft.data ?? null,
      ...(draft.evidence ? { evidence: draft.evidence } : {}),
      recordedAt: new Date().toISOString(),
      previousHash,
    }
    const hash = digest(body)
    const event = immutable<LedgerEvent>({ id: `event_${seq}_${hash.slice(0, 12)}`, ...body, hash })
    if (this.#file !== null) {
      writeFileSync(this.#file, `${JSON.stringify(event)}\n`)
      fsyncSync(this.#file)
    }
    this.#events.push(event)
    return event
  }

  get(id: string): LedgerEvent {
    const event = this.#events.find((item) => item.id === id)
    if (!event) throw new Error(`unknown Event: ${id}`)
    return event
  }

  all(): LedgerEvent[] {
    return [...this.#events]
  }

  inScope(scope: Scope): LedgerEvent[] {
    return this.#events.filter((event) => sameScope(event.scope, scope))
  }

  visibleToFork(forkId: string, activeFrontier: number): LedgerEvent[] {
    return this.#events.filter(
      (event) =>
        (event.scope.kind === "active" && event.seq <= activeFrontier) ||
        (event.scope.kind === "fork" && event.scope.forkId === forkId),
    )
  }

  head(): { seq: number; hash: string | null } {
    const last = this.#events.at(-1)
    return { seq: last?.seq ?? 0, hash: last?.hash ?? null }
  }

  verify(): boolean {
    let previousHash: string | null = null
    for (let index = 0; index < this.#events.length; index += 1) {
      const event = this.#events[index]
      if (!event) return false
      const { id: _id, hash, ...body } = event
      if (event.seq !== index + 1 || event.previousHash !== previousHash || digest(body) !== hash) return false
      previousHash = hash
    }
    return true
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#file === null) return
    fsyncSync(this.#file)
    closeSync(this.#file)
    this.#file = null
  }
}

export function activeScope(): Scope {
  return immutable({ kind: "active" })
}

export function forkScope(forkId: string): Scope {
  if (!forkId) throw new Error("Fork scope requires forkId")
  return immutable({ kind: "fork", forkId })
}

export function sameScope(left: Scope, right: Scope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "active") return true
  return right.kind === "fork" && left.forkId === right.forkId
}

function validateDraft(draft: EventDraft): void {
  if (!draft || typeof draft !== "object") throw new TypeError("Event draft is required")
  if (typeof draft.type !== "string" || draft.type.length === 0) throw new TypeError("Event type is required")
  if (typeof draft.actor !== "string" || draft.actor.length === 0) throw new TypeError("Event actor is required")
  if (!draft.scope || (draft.scope.kind !== "active" && draft.scope.kind !== "fork")) {
    throw new TypeError("Event scope must be active or fork")
  }
  if (draft.scope.kind === "fork" && !draft.scope.forkId) throw new TypeError("Fork scope requires forkId")
}
