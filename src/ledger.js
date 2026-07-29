import { digest, immutable } from "./canonical.js"

export class Ledger {
  #events = []

  append(draft) {
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
    const event = immutable({ id: `event_${seq}_${hash.slice(0, 12)}`, ...body, hash })
    this.#events.push(event)
    return event
  }

  get(id) {
    const event = this.#events.find((item) => item.id === id)
    if (!event) throw new Error(`unknown Event: ${id}`)
    return event
  }

  all() {
    return [...this.#events]
  }

  inScope(scope) {
    return this.#events.filter((event) => sameScope(event.scope, scope))
  }

  visibleToFork(forkId, activeFrontier) {
    return this.#events.filter(
      (event) =>
        (event.scope.kind === "active" && event.seq <= activeFrontier) ||
        (event.scope.kind === "fork" && event.scope.forkId === forkId),
    )
  }

  head() {
    const last = this.#events.at(-1)
    return { seq: last?.seq ?? 0, hash: last?.hash ?? null }
  }

  verify() {
    let previousHash = null
    for (let index = 0; index < this.#events.length; index += 1) {
      const event = this.#events[index]
      const { id: _id, hash, ...body } = event
      if (event.seq !== index + 1 || event.previousHash !== previousHash || digest(body) !== hash) {
        return false
      }
      previousHash = hash
    }
    return true
  }
}

export function activeScope() {
  return immutable({ kind: "active" })
}

export function forkScope(forkId) {
  if (!forkId) throw new Error("Fork scope requires forkId")
  return immutable({ kind: "fork", forkId })
}

function validateDraft(draft) {
  if (!draft || typeof draft !== "object") throw new TypeError("Event draft is required")
  if (typeof draft.type !== "string" || draft.type.length === 0) throw new TypeError("Event type is required")
  if (typeof draft.actor !== "string" || draft.actor.length === 0) throw new TypeError("Event actor is required")
  if (!draft.scope || (draft.scope.kind !== "active" && draft.scope.kind !== "fork")) {
    throw new TypeError("Event scope must be active or fork")
  }
  if (draft.scope.kind === "fork" && !draft.scope.forkId) throw new TypeError("Fork scope requires forkId")
}

function sameScope(left, right) {
  return left.kind === right.kind && (left.kind === "active" || left.forkId === right.forkId)
}
