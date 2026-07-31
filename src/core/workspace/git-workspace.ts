import { execFile } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { digest, immutable } from "../canonical.ts"

export interface WorkspaceCommit {
  workspaceId: string
  commit: string
  tree: string
}

export interface WorkspaceCheckout {
  workspaceId: string
  repository: string
  worktree: string
  baseCommit: string
}

export interface CommittedWorkspaceChange extends WorkspaceCommit {
  parentCommit: string
  message: string
}

export interface WorkspaceCheckoutResult {
  head: WorkspaceCommit
  commits: CommittedWorkspaceChange[]
  restored: boolean
}

export interface ReappliedWorkspaceCommit {
  sourceCommit: string
  appliedCommit: string
}

export interface WorkspaceReapplyResult {
  head: WorkspaceCommit
  commits: ReappliedWorkspaceCommit[]
}

export type WorkspaceFiles = Record<string, string | Uint8Array>

export class GitWorkspaceStore {
  readonly root: string
  #repositoryOperations = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = resolve(root)
  }

  async initialize(workspaceId: string, files: WorkspaceFiles = {}): Promise<WorkspaceCommit> {
    const repository = this.#repository(workspaceId)
    await mkdir(dirname(repository), { recursive: true })
    await mkdir(repository)
    await git(repository, ["init", "-b", "main"])
    await git(repository, ["config", "user.name", "Corallum Workspace"])
    await git(repository, ["config", "user.email", "workspace@corallum.local"])
    for (const [path, content] of Object.entries(files)) {
      const target = safePath(repository, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      if (path.startsWith("bin/")) await chmod(target, 0o755)
    }
    await git(repository, ["add", "-A"])
    await git(repository, ["commit", "--allow-empty", "-m", "Initialize workspace"])
    return this.resolveCommit(workspaceId, "HEAD")
  }

  async verify(workspaceId: string, commit: string): Promise<WorkspaceCommit> {
    assertCommitId(commit)
    const resolved = await this.resolveCommit(workspaceId, `${commit}^{commit}`)
    if (resolved.commit !== commit) throw new Error(`unknown commit for workspace ${workspaceId}: ${commit}`)
    return resolved
  }

  async isRoot(workspaceId: string, commit: string): Promise<boolean> {
    await this.verify(workspaceId, commit)
    const line = (await git(this.#repository(workspaceId), ["rev-list", "--parents", "-n", "1", commit])).trim()
    return line.split(/\s+/).length === 1
  }

  async rootCommit(workspaceId: string, commit: string): Promise<WorkspaceCommit> {
    await this.verify(workspaceId, commit)
    const roots = (await git(this.#repository(workspaceId), ["rev-list", "--max-parents=0", commit]))
      .trim()
      .split("\n")
      .filter(Boolean)
    if (roots.length !== 1) throw new Error(`workspace must have exactly one initial commit: ${workspaceId}`)
    return this.resolveCommit(workspaceId, roots[0]!)
  }

  async reapplyTail(
    workspaceId: string,
    baseCommit: string,
    currentHead: string,
    targetHead: string,
    operationId: string,
  ): Promise<WorkspaceReapplyResult> {
    await Promise.all([
      this.verify(workspaceId, baseCommit),
      this.verify(workspaceId, currentHead),
      this.verify(workspaceId, targetHead),
    ])
    if (!(await this.#isAncestor(workspaceId, baseCommit, currentHead))) {
      throw new Error(`Main workspace head does not descend from Fork source: ${workspaceId}`)
    }
    if (!(await this.#isAncestor(workspaceId, baseCommit, targetHead))) {
      throw new Error(`Fork workspace head does not descend from its source: ${workspaceId}`)
    }
    if (currentHead === baseCommit || currentHead === targetHead) {
      return { head: await this.verify(workspaceId, targetHead), commits: [] }
    }
    if (targetHead === baseCommit) {
      return { head: await this.verify(workspaceId, currentHead), commits: [] }
    }

    const commits = (await git(this.#repository(workspaceId), ["rev-list", "--reverse", `${baseCommit}..${currentHead}`]))
      .trim()
      .split("\n")
      .filter(Boolean)
    const checkout = await this.open(workspaceId, targetHead, operationId)
    const reapplied: ReappliedWorkspaceCommit[] = []
    try {
      for (const sourceCommit of commits) {
        try {
          await git(checkout.worktree, ["cherry-pick", sourceCommit], {
            GIT_COMMITTER_NAME: "Corallum Runtime",
            GIT_COMMITTER_EMAIL: "runtime@corallum.local",
          })
        } catch (error) {
          await git(checkout.worktree, ["cherry-pick", "--abort"]).catch(() => undefined)
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Cannot reapply commit for workspace ${workspaceId}: ${sourceCommit}: ${message}`)
        }
        reapplied.push({ sourceCommit, appliedCommit: (await this.resolveCommit(workspaceId, "HEAD", checkout.worktree)).commit })
      }
      return { head: await this.resolveCommit(workspaceId, "HEAD", checkout.worktree), commits: reapplied }
    } finally {
      await this.close(checkout)
    }
  }

  async open(workspaceId: string, commit: string, runId: string): Promise<WorkspaceCheckout> {
    await this.verify(workspaceId, commit)
    const repository = this.#repository(workspaceId)
    const worktree = join(this.root, ".worktrees", digest({ workspaceId, runId, commit }).slice(0, 24))
    await mkdir(dirname(worktree), { recursive: true })
    await this.#withRepository(workspaceId, () => git(repository, ["worktree", "add", "--detach", worktree, commit]))
    return immutable({ workspaceId, repository, worktree, baseCommit: commit })
  }

  async finalizeCheckout(checkout: WorkspaceCheckout): Promise<WorkspaceCheckoutResult> {
    const restored = (await git(checkout.worktree, ["status", "--porcelain"])).trim() !== ""
    if (restored) {
      await git(checkout.worktree, ["reset", "--hard", "HEAD"])
      await git(checkout.worktree, ["clean", "-fd"])
    }

    const head = await this.resolveCommit(checkout.workspaceId, "HEAD", checkout.worktree)
    if (head.commit === checkout.baseCommit) return immutable({ head, commits: [], restored })
    if (!(await gitSucceeds(checkout.worktree, ["merge-base", "--is-ancestor", checkout.baseCommit, head.commit]))) {
      throw new Error(`Workspace HEAD does not descend from its turn base: ${checkout.workspaceId}`)
    }

    const lines = (await git(checkout.worktree, [
      "rev-list",
      "--reverse",
      "--parents",
      `${checkout.baseCommit}..${head.commit}`,
    ])).trim().split("\n").filter(Boolean)
    const commits: CommittedWorkspaceChange[] = []
    let parentCommit = checkout.baseCommit
    for (const line of lines) {
      const [commit, ...parents] = line.split(/\s+/)
      if (!commit || parents.length !== 1 || parents[0] !== parentCommit) {
        throw new Error(`Workspace commits must form a linear history: ${checkout.workspaceId}`)
      }
      const resolved = await this.resolveCommit(checkout.workspaceId, commit, checkout.worktree)
      const message = (await git(checkout.worktree, ["show", "-s", "--format=%B", commit])).trimEnd()
      commits.push(immutable({ ...resolved, parentCommit, message }))
      parentCommit = commit
    }
    return immutable({ head, commits, restored })
  }

  async retain(workspaceId: string, key: string, commit: string): Promise<void> {
    const ref = `refs/kept/${digest(key).slice(0, 24)}`
    await git(this.#repository(workspaceId), ["update-ref", ref, commit])
  }

  async setRef(workspaceId: string, ref: string, commit: string): Promise<void> {
    await this.verify(workspaceId, commit)
    await this.#withRepository(workspaceId, () => git(this.#repository(workspaceId), ["update-ref", ref, commit]))
  }

  async compareAndSwapRef(workspaceId: string, ref: string, commit: string, expected: string): Promise<boolean> {
    await Promise.all([this.verify(workspaceId, commit), this.verify(workspaceId, expected)])
    return this.#withRepository(workspaceId, async () => {
      try {
        await git(this.#repository(workspaceId), ["update-ref", ref, commit, expected])
        return true
      } catch (error) {
        if ((await this.resolveCommit(workspaceId, ref)).commit !== expected) return false
        throw error
      }
    })
  }

  async close(checkout: WorkspaceCheckout): Promise<void> {
    await this.#withRepository(checkout.workspaceId, () =>
      git(checkout.repository, ["worktree", "remove", "--force", checkout.worktree]),
    )
  }

  async resolveCommit(workspaceId: string, ref: string, cwd = this.#repository(workspaceId)): Promise<WorkspaceCommit> {
    const commit = (await git(cwd, ["rev-parse", ref])).trim()
    const tree = (await git(cwd, ["rev-parse", `${ref}^{tree}`])).trim()
    return immutable({ workspaceId, commit, tree })
  }

  async read(workspaceId: string, commit: string, path: string): Promise<string> {
    assertRelativePath(path)
    return git(this.#repository(workspaceId), ["show", `${commit}:${path}`])
  }

  async exportTree(workspaceId: string, commit: string, destination: string): Promise<void> {
    const repository = this.#repository(workspaceId)
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

  async exportBundle(workspaceId: string, commit: string, destination: string): Promise<void> {
    await this.verify(workspaceId, commit)
    const repository = this.#repository(workspaceId)
    await mkdir(dirname(destination), { recursive: true })
    const exportRef = `refs/heads/corallum-export-${commit.slice(0, 16)}`
    await this.#withRepository(workspaceId, async () => {
      await git(repository, ["update-ref", exportRef, commit])
      try {
        await git(repository, ["bundle", "create", destination, exportRef])
      } finally {
        await git(repository, ["update-ref", "-d", exportRef])
      }
    })
  }

  async importBundle(workspaceId: string, bundle: string): Promise<void> {
    const repository = this.#repository(workspaceId)
    await mkdir(this.root, { recursive: true })
    await mkdir(dirname(repository), { recursive: true })
    await git(this.root, ["clone", "--bare", bundle, repository])
  }

  #repository(workspaceId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(workspaceId)) throw new Error(`invalid workspace ID: ${workspaceId}`)
    return join(this.root, workspaceId)
  }

  async #withRepository<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#repositoryOperations.get(workspaceId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.#repositoryOperations.set(
      workspaceId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    )
    return current
  }

  async #isAncestor(workspaceId: string, ancestor: string, descendant: string): Promise<boolean> {
    return gitSucceeds(this.#repository(workspaceId), ["merge-base", "--is-ancestor", ancestor, descendant])
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

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", ["-C", cwd, ...args], (error) => {
      if (!error) resolvePromise(true)
      else if (error.code === 1) resolvePromise(false)
      else rejectPromise(error)
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

function assertCommitId(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error(`invalid workspace commit: ${commit}`)
}
