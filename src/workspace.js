import { execFile } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { digest, immutable } from "./canonical.js"

const runFile = promisify(execFile)

export class GitWorkspaceStore {
  constructor(root) {
    this.root = resolve(root)
  }

  async initialize(agentId, files = {}) {
    const repository = this.#repository(agentId)
    await mkdir(repository, { recursive: true })
    await git(repository, ["init", "-b", "main"])
    await git(repository, ["config", "user.name", `Agent ${agentId}`])
    await git(repository, ["config", "user.email", `${agentId}@swarm.local`])
    for (const [path, content] of Object.entries(files)) {
      const target = safePath(repository, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    await git(repository, ["add", "-A"])
    await git(repository, ["commit", "--allow-empty", "-m", "Initialize Agent workspace"])
    return this.revision(agentId, "HEAD")
  }

  async open(agentId, commit, runId) {
    const repository = this.#repository(agentId)
    const worktree = join(this.root, ".worktrees", digest({ agentId, runId, commit }).slice(0, 24))
    await mkdir(dirname(worktree), { recursive: true })
    await git(repository, ["worktree", "add", "--detach", worktree, commit])
    return immutable({ agentId, repository, worktree, baseCommit: commit })
  }

  async commit(checkout, message) {
    await git(checkout.worktree, ["add", "-A"])
    const status = await git(checkout.worktree, ["status", "--porcelain"])
    if (status.trim() === "") return this.revision(checkout.agentId, checkout.baseCommit)

    await git(checkout.worktree, ["commit", "-m", message], {
      GIT_AUTHOR_NAME: `Agent ${checkout.agentId}`,
      GIT_AUTHOR_EMAIL: `${checkout.agentId}@swarm.local`,
      GIT_COMMITTER_NAME: `Agent ${checkout.agentId}`,
      GIT_COMMITTER_EMAIL: `${checkout.agentId}@swarm.local`,
    })
    return this.revision(checkout.agentId, "HEAD", checkout.worktree)
  }

  async retain(agentId, key, commit) {
    const ref = `refs/kept/${digest(key).slice(0, 24)}`
    await git(this.#repository(agentId), ["update-ref", ref, commit])
  }

  async close(checkout) {
    await git(checkout.repository, ["worktree", "remove", "--force", checkout.worktree])
  }

  async revision(agentId, ref, cwd = this.#repository(agentId)) {
    const commit = (await git(cwd, ["rev-parse", ref])).trim()
    const tree = (await git(cwd, ["rev-parse", `${ref}^{tree}`])).trim()
    return immutable({ agentId, commit, tree })
  }

  async read(agentId, commit, path) {
    assertRelativePath(path)
    return git(this.#repository(agentId), ["show", `${commit}:${path}`])
  }

  async exportTree(agentId, commit, destination) {
    const repository = this.#repository(agentId)
    await mkdir(destination, { recursive: true })
    const listing = await gitBuffer(repository, ["ls-tree", "-r", "-z", commit])
    for (const entry of listing.toString("utf8").split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t")
      const [mode, type, object] = metadata.split(" ")
      if (type !== "blob") throw new Error(`Snapshot only supports Git blobs: ${path}`)
      const target = safePath(destination, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await gitBuffer(repository, ["cat-file", "blob", object]))
      if (mode === "100755") await chmod(target, 0o755)
    }
  }

  #repository(agentId) {
    if (!/^[a-zA-Z0-9._-]+$/.test(agentId)) throw new Error(`invalid Agent ID: ${agentId}`)
    return join(this.root, "agents", agentId)
  }
}

async function git(cwd, args, extraEnvironment = {}) {
  try {
    const { stdout } = await runFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnvironment },
    })
    return stdout
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
}

async function gitBuffer(cwd, args) {
  try {
    const { stdout } = await runFile("git", ["-C", cwd, ...args], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
}

function safePath(root, path) {
  assertRelativePath(path)
  const target = resolve(root, path)
  if (relative(root, target).startsWith("..")) throw new Error(`path escapes workspace: ${path}`)
  return target
}

function assertRelativePath(path) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid workspace path: ${path}`)
  }
}
