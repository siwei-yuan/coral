import assert from "node:assert/strict"
import test from "node:test"
import { ChatPlugin, forkScope } from "../src/index.js"
import { createFixture } from "../test-support/fixture.js"

test("Chat is a transport Plugin over Communication Events and only active speaker can egress", async (t) => {
  const { swarm, ledger } = await createFixture(t)
  const sent = []
  const chat = new ChatPlugin({ send: async (message) => sent.push(message) })

  const inbound = swarm.ingest(
    chat.ingress({
      userId: "user-1",
      conversationId: "conversation-1",
      text: "hello",
      externalRef: "message-1",
    }),
  )
  assert.equal(inbound.type, "communication.sent")
  assert.deepEqual(inbound.data.to, ["agent/builder"])

  const outbound = ledger.append({
    type: "communication.sent",
    actor: "agent/builder",
    scope: { kind: "active" },
    causation: [inbound.id],
    data: {
      conversationId: "conversation-1",
      from: "agent/builder",
      to: ["external/user/user-1"],
      content: [{ type: "text", text: "hi" }],
    },
  })
  await chat.egress(outbound, swarm.pluginBindingForEgress("chat", outbound))
  assert.equal(sent.length, 1)

  const forkedOutbound = ledger.append({
    type: "communication.sent",
    actor: "agent/builder",
    scope: forkScope("fork-for-test"),
    data: outbound.data,
  })
  assert.throws(
    () => swarm.pluginBindingForEgress("chat", forkedOutbound),
    /Fork Events cannot use live external egress/,
  )
})
