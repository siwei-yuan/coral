export default async function compose({ read, inputEvents }) {
  return [
    { role: "system", content: await read("AGENTS.md") },
    { role: "user", content: await read("context/initial.md") },
    { role: "user", content: JSON.stringify(inputEvents) },
  ]
}
