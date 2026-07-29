import { createHash } from "node:crypto"

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 24)}`
}

export function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values require finite numbers")
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    )
  }
  throw new TypeError(`unsupported canonical value: ${typeof value}`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}
