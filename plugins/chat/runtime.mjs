import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createView } from "./view.mjs"

export async function start({ id, stateRoot, emit }) {
  if (id !== "chat") throw new Error(`Invalid Chat Plugin ID: ${id}`)
  const inbox = join(stateRoot, "inbox")
  const outbox = join(stateRoot, "outbox")
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(outbox, { recursive: true })])

  async function submit({ userId, conversationId, text }) {
    if (!userId || !conversationId || !text) throw new Error("Chat ingress requires user, conversation, and text")
    const receivedAt = new Date().toISOString()
    const externalRef = randomUUID()
    await writeFile(join(inbox, `${externalRef}.json`), `${JSON.stringify({ userId, conversationId, text, receivedAt })}\n`, { flag: "wx" })
    await emit({
      type: "communication.sent",
      actor: `external/user/${userId}`,
      data: {
        conversationId,
        from: `external/user/${userId}`,
        to: [],
        content: [{ type: "text", text }],
        source: { plugin: id, externalRef },
      },
    })
  }

  async function messages() {
    const inbound = await readJsonDirectory(inbox)
    const outbound = await readJsonDirectory(outbox)
    return [
      ...inbound.map((message) => ({ id: message.id, direction: "in", conversationId: message.conversationId, text: message.text, at: message.receivedAt })),
      ...outbound.map((reply) => ({ id: reply.id, direction: "out", conversationId: reply.conversationId, text: reply.text, at: reply.queuedAt })),
    ].sort((left, right) => left.at.localeCompare(right.at))
  }

  return {
    view: createView({ messages, submit }),
    async stop() {},
  }
}

async function readJsonDirectory(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
  return Promise.all(files.map(async (file) => ({
    id: file.slice(0, -5),
    ...JSON.parse(await readFile(join(directory, file), "utf8")),
  })))
}
