import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Swarm } from "../../core/swarm/runtime.ts"
import type { ForkSnapshot, SwarmRevision } from "../../core/swarm/revision.ts"
import type { ViewExtension, ViewExtensionLink } from "../extension.ts"
import { projectLedger, type DefaultViewModel } from "./project.ts"
import { renderDefaultView, renderExtensionPage, renderTopologySection } from "./render.ts"

export class DefaultView {
  readonly swarm: Swarm
  readonly human: string
  readonly #extensionSource: () => ViewExtension[]

  constructor({
    swarm,
    human,
    extensions = () => [],
  }: {
    swarm: Swarm
    human: string
    extensions?: () => ViewExtension[]
  }) {
    this.swarm = swarm
    this.human = human
    this.#extensionSource = extensions
  }

  model(): DefaultViewModel {
    return projectLedger(this.swarm.ledger.all())
  }

  render(notice?: string): string {
    return renderDefaultView(this.model(), this.#links(), notice)
  }

  async fork(sourceId: string): Promise<ForkSnapshot> {
    const fork = this.swarm.createFork(sourceId, this.human)
    return this.swarm.runFork(fork.id)
  }

  approve(forkId: string, expectedFrontier: number): Promise<SwarmRevision> {
    return this.swarm.approve(forkId, expectedFrontier, this.human)
  }

  async deny(forkId: string, expectedFrontier: number, reason?: string): Promise<void> {
    await this.swarm.deny(forkId, expectedFrontier, this.human, reason)
  }

  listen({ host = "127.0.0.1", port = 0 }: { host?: string; port?: number } = {}): Promise<DefaultViewServer> {
    const server = createServer((request, response) => void this.#handle(request, response))
    return new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, () => {
        server.off("error", reject)
        const address = server.address() as AddressInfo
        resolve({ server, url: `http://${address.address}:${address.port}` })
      })
    })
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost")
      const path = url.pathname
      const extensionRoute = extensionPath(path)
      if (request.method === "GET" && path === "/") return html(response, 200, this.render())
      if (request.method === "GET" && path === "/_view/topology") {
        const model = this.model()
        const head = model.events.at(-1)?.seq ?? 0
        if (head <= Number(url.searchParams.get("after") ?? -1)) {
          response.writeHead(204, { "cache-control": "no-store" }).end()
          return
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
        }).end(renderTopologySection(model))
        return
      }
      if (request.method === "GET" && extensionRoute?.action === null) {
        const extension = this.#extension(extensionRoute.plugin)
        return html(
          response,
          200,
          renderExtensionPage(this.#link(extension), await extension.render(), this.#links()),
        )
      }
      if (request.method === "GET" && extensionRoute?.action) {
        const extension = this.#extension(extensionRoute.plugin)
        if (!extension.read) throw new Error(`View extension has no readable resources: ${extension.plugin}`)
        const result = await extension.read(extensionRoute.action, url.searchParams, {
          events: this.swarm.ledger.all().filter((event) => event.actor === `plugin/${extension.plugin}`),
        })
        response.writeHead(200, {
          "content-type": result.contentType,
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
        }).end(result.body)
        return
      }
      if (request.method !== "POST") return html(response, 404, this.render("Page not found"))
      const form = await readForm(request)
      if (path === "/fork") await this.fork(required(form, "sourceId"))
      else if (path === "/approve") await this.approve(required(form, "forkId"), frontier(form))
      else if (path === "/deny") await this.deny(required(form, "forkId"), frontier(form), form.get("reason") || undefined)
      else if (extensionRoute?.action) {
        const extension = this.#extension(extensionRoute.plugin)
        if (!extension.handle) throw new Error(`View extension has no actions: ${extension.plugin}`)
        await extension.handle(extensionRoute.action, form)
        response.writeHead(303, { location: `/extensions/${encodeURIComponent(extension.plugin)}` }).end()
        return
      }
      else return html(response, 404, this.render("Page not found"))
      response.writeHead(303, { location: "/" }).end()
    } catch (error) {
      html(response, 400, this.render(error instanceof Error ? error.message : String(error)))
    }
  }

  #links(): ViewExtensionLink[] {
    const activePlugins = new Set(this.swarm.activeRevision().definition.plugins.map((plugin) => plugin.id))
    return [...this.#extensions().values()].filter((extension) => activePlugins.has(extension.plugin)).map((extension) => this.#link(extension))
  }

  #link(extension: ViewExtension): ViewExtensionLink {
    return { plugin: extension.plugin, title: extension.title }
  }

  #extension(plugin: string): ViewExtension {
    const extension = this.#extensions().get(plugin)
    if (!extension || !this.swarm.activeRevision().definition.plugins.some((binding) => binding.id === plugin)) {
      throw new Error(`View extension is not active: ${plugin}`)
    }
    return extension
  }

  #extensions(): Map<string, ViewExtension> {
    const extensions = new Map<string, ViewExtension>()
    for (const extension of this.#extensionSource()) {
      if (extensions.has(extension.plugin)) throw new Error(`Duplicate View extension: ${extension.plugin}`)
      extensions.set(extension.plugin, extension)
    }
    return extensions
  }
}

export interface DefaultViewServer {
  server: Server
  url: string
}

export { projectLedger, renderDefaultView, renderExtensionPage }
export type {
  DefaultViewModel,
  EvolutionNodeView,
  ForkTestView,
  ForkView,
  ProposalView,
  RevisionView,
} from "./project.ts"

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
}

function required(form: URLSearchParams, key: string): string {
  const value = form.get(key)
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

function frontier(form: URLSearchParams): number {
  const value = Number(required(form, "frontier"))
  if (!Number.isInteger(value) || value < 1) throw new Error("Invalid fork frontier")
  return value
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; img-src 'self' data:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'" }).end(body)
}

function extensionPath(path: string): { plugin: string; action: string | null } | null {
  const match = /^\/extensions\/([^/]+)(?:\/([^/]+))?$/.exec(path)
  return match ? { plugin: decodeURIComponent(match[1]!), action: match[2] ? decodeURIComponent(match[2]) : null } : null
}
