import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Swarm } from "../../core/swarm/runtime.ts"
import type { ForkSnapshot, SwarmRevision } from "../../core/swarm/revision.ts"
import { projectLedger, type DefaultViewModel } from "./project.ts"
import { renderDefaultView } from "./render.ts"

export class DefaultView {
  readonly swarm: Swarm
  readonly human: string

  constructor(swarm: Swarm, human: string) {
    this.swarm = swarm
    this.human = human
  }

  model(): DefaultViewModel {
    return projectLedger(this.swarm.ledger.all())
  }

  render(notice?: string): string {
    return renderDefaultView(this.model(), notice)
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
      if (request.method === "GET" && request.url === "/") return html(response, 200, this.render())
      if (request.method !== "POST") return html(response, 404, this.render("Page not found"))
      const form = await readForm(request)
      if (request.url === "/fork") await this.fork(required(form, "sourceId"))
      else if (request.url === "/approve") await this.approve(required(form, "forkId"), frontier(form))
      else if (request.url === "/deny") await this.deny(required(form, "forkId"), frontier(form), form.get("reason") || undefined)
      else return html(response, 404, this.render("Page not found"))
      response.writeHead(303, { location: "/" }).end()
    } catch (error) {
      html(response, 400, this.render(error instanceof Error ? error.message : String(error)))
    }
  }
}

export interface DefaultViewServer {
  server: Server
  url: string
}

export { projectLedger, renderDefaultView }
export type { DefaultViewModel, ForkTestView, ForkView, ProposalView, RevisionView } from "./project.ts"

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
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" }).end(body)
}
