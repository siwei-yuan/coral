import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { createServer } from "node:http"

const WEBHOOK_PATH = "/webhooks/composio"
const SIGNATURE_TOLERANCE_SECONDS = 300

export async function start({ id, mode, env, emit }) {
  if (id !== "composio") throw new Error(`Invalid Composio Plugin ID: ${id}`)
  if (mode !== "live" || env.CORAL_COMPOSIO_TRIGGER_INGRESS !== "1") {
    return { async stop() {} }
  }

  const secret = randomBytes(32).toString("hex")

  const server = createServer((request, response) => {
    receive(request, response, id, secret, emit).catch((error) => {
      console.error("Composio webhook:", error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === "string") {
    await close(server)
    throw new Error("Composio webhook listener has no TCP address")
  }

  const executable = env.CORAL_COMPOSIO_EXECUTABLE ?? "composio"
  const child = spawn(executable, [
    "dev",
    "listen",
    "--forward",
    `http://127.0.0.1:${address.port}${WEBHOOK_PATH}`,
  ], {
    env: { ...process.env, ...env, COMPOSIO_WEBHOOK_SECRET: secret },
    stdio: ["ignore", "ignore", "inherit"],
  })
  let stopping = false
  let exitStatus = null
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    exitStatus = { code, signal }
    if (!stopping) console.error(`Composio trigger listener exited unexpectedly: ${signal ?? code}`)
    resolve()
  }))
  try {
    await spawned(child)
    if (exitStatus) throw new Error(`Composio trigger listener failed to stay running: ${exitStatus.signal ?? exitStatus.code}`)
  } catch (error) {
    await close(server)
    throw error
  }

  return {
    async stop() {
      stopping = true
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT")
      await Promise.all([close(server), exited])
    },
  }
}

async function receive(request, response, pluginId, secret, emit) {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (path !== WEBHOOK_PATH) return respond(response, 404)
  if (request.method !== "POST") return respond(response, 405)

  const body = await readBody(request)
  try {
    verify(body, request.headers, secret)
  } catch (error) {
    console.error("Composio webhook signature:", error)
    return respond(response, 401)
  }

  let envelope
  try {
    envelope = JSON.parse(body)
  } catch {
    return respond(response, 400)
  }
  if (envelope?.type !== "composio.trigger.message") return respond(response, 204)
  if (!validEnvelope(envelope)) return respond(response, 400)

  await emit({
    type: "communication.sent",
    actor: `plugin/${pluginId}`,
    schema: envelope.type,
    data: {
      from: `plugin/${pluginId}`,
      to: [],
      source: { plugin: pluginId, externalRef: envelope.id },
      content: [envelope],
    },
  })
  respond(response, 204)
}

function verify(body, headers, secret) {
  const webhookId = header(headers["webhook-id"])
  const timestamp = header(headers["webhook-timestamp"])
  const signature = header(headers["webhook-signature"])
  if (!webhookId || !timestamp || !signature) throw new Error("missing signature headers")

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) throw new Error("invalid webhook timestamp")
  if (Math.abs(Date.now() / 1_000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error("expired webhook timestamp")
  }

  const expected = createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${body}`).digest()
  const encoded = signature.includes(",") ? signature.slice(signature.indexOf(",") + 1) : signature
  const received = Buffer.from(encoded, "base64")
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("invalid webhook signature")
  }
}

function validEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    value.metadata &&
    typeof value.metadata === "object" &&
    typeof value.metadata.trigger_slug === "string" &&
    typeof value.metadata.trigger_id === "string" &&
    typeof value.metadata.connected_account_id === "string" &&
    typeof value.metadata.user_id === "string",
  )
}

function header(value) {
  return Array.isArray(value) ? value[0] : value
}

async function readBody(request) {
  request.setEncoding("utf8")
  let body = ""
  for await (const chunk of request) body += chunk
  return body
}

function respond(response, status) {
  response.writeHead(status).end()
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function close(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function spawned(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
}
