import { execFile } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { digest, immutable } from "../canonical.ts"

export interface WorkspaceRevision {
  agentId: string
  commit: string
  tree: string
}

export interface WorkspaceCheckout {
  agentId: string
  repository: string
  worktree: string
  baseCommit: string
}

export type WorkspaceFiles = Record<string, string | Uint8Array>

export class GitWorkspaceStore {
  readonly root: string
  #repositoryOperations = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = resolve(root)
  }

  async initialize(agentId: string, files: WorkspaceFiles = {}): Promise<WorkspaceRevision> {
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

  async open(agentId: string, commit: string, runId: string): Promise<WorkspaceCheckout> {
    const repository = this.#repository(agentId)
    const worktree = join(this.root, ".worktrees", digest({ agentId, runId, commit }).slice(0, 24))
    await mkdir(dirname(worktree), { recursive: true })
    await this.#withRepository(agentId, () => git(repository, ["worktree", "add", "--detach", worktree, commit]))
    return immutable({ agentId, repository, worktree, baseCommit: commit })
  }

  async commit(checkout: WorkspaceCheckout, message: string): Promise<WorkspaceRevision> {
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

  async retain(agentId: string, key: string, commit: string): Promise<void> {
    const ref = `refs/kept/${digest(key).slice(0, 24)}`
    await git(this.#repository(agentId), ["update-ref", ref, commit])
  }

  async close(checkout: WorkspaceCheckout): Promise<void> {
    await this.#withRepository(checkout.agentId, () =>
      git(checkout.repository, ["worktree", "remove", "--force", checkout.worktree]),
    )
  }

  async revision(agentId: string, ref: string, cwd = this.#repository(agentId)): Promise<WorkspaceRevision> {
    const commit = (await git(cwd, ["rev-parse", ref])).trim()
    const tree = (await git(cwd, ["rev-parse", `${ref}^{tree}`])).trim()
    return immutable({ agentId, commit, tree })
  }

  async read(agentId: string, commit: string, path: string): Promise<string> {
    assertRelativePath(path)
    return git(this.#repository(agentId), ["show", `${commit}:${path}`])
  }

  async exportTree(agentId: string, commit: string, destination: string): Promise<void> {
    const repository = this.#repository(agentId)
    await mkdir(destination, { recursive: true })
    const listing = await gitBuffer(repository, ["ls-tree", "-r", "-z", commit])
    for (const entry of listing.toString("utf8").split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t")
      if (!metadata || !path) throw new Error(`Invalid Git tree entry: ${entry}`)
      const [mode, type, object] = metadata.split(" ")
      if (type !== "blob" || !object) throw new Error(`Snapshot only supports Git blobs: ${path}`)
      const target = safePath(destination, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await gitBuffer(repository, ["cat-file", "blob", object]))
      if (mode === "100755") await chmod(target, 0o755)
    }
  }

  #repository(agentId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(agentId)) throw new Error(`invalid Agent ID: ${agentId}`)
    return join(this.root, "agents", agentId)
  }

  async #withRepository<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#repositoryOperations.get(agentId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.#repositoryOperations.set(
      agentId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    )
    return current
  }
}

async function git(cwd: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", env: { ...process.env, ...extraEnvironment } },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`))
        else resolvePromise(stdout)
      },
    )
  })
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(`git ${args.join(" ")} failed: ${stderr.toString().trim() || error.message}`))
      else resolvePromise(stdout)
    })
  })
}

function safePath(root: string, path: string): string {
  assertRelativePath(path)
  const target = resolve(root, path)
  if (relative(root, target).startsWith("..")) throw new Error(`path escapes workspace: ${path}`)
  return target
}

function assertRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid workspace path: ${path}`)
  }
}
