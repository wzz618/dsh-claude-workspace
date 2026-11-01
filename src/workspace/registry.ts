import { CcwError } from '../util/errors.ts'

/** A DSH workspace registration performed for a CCW workspace. */
export interface WorkspaceRegistration {
  /** DSH's `workspaceId`. */
  readonly id: string
}

/**
 * Registers a directory as a DSH Workspace so the sidebar, ordering, pinning,
 * and archiving all remain owned by DSH instead of a second registry.
 */
export interface WorkspaceRegistry {
  readonly available: boolean
  register(input: { path: string; title: string }): Promise<WorkspaceRegistration | undefined>
  rename(workspaceId: string, title: string): Promise<void>
  remove(workspaceId: string): Promise<void>
}

/** The subset of `ctx.workspaceController` this plugin calls. */
export interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: { workspaceId: string; title: string } }>
  rename(request: { workspaceId: string; title: string }): Promise<unknown>
  delete(request: { workspaceId: string }): Promise<unknown>
}

/**
 * Adapts DSH's workspace controller. `create` is idempotent by path, so
 * re-adding an existing directory returns the existing Workspace.
 */
export class DshWorkspaceRegistry implements WorkspaceRegistry {
  readonly available = true
  readonly #controller: WorkspaceControllerLike

  constructor(controller: WorkspaceControllerLike) {
    this.#controller = controller
  }

  async register(input: { path: string; title: string }): Promise<WorkspaceRegistration> {
    let created: { workspace: { workspaceId: string; title: string } }
    try {
      created = await this.#controller.create({ path: input.path })
    } catch (error) {
      throw new CcwError(
        'workspace-registration-failed',
        `could not register ${input.path} with DSH: ${messageOf(error)}`,
        { path: input.path },
        { cause: error },
      )
    }
    const id = created.workspace.workspaceId
    if (created.workspace.title !== input.title) {
      try {
        await this.#controller.rename({ workspaceId: id, title: input.title })
      } catch (error) {
        await this.#controller.delete({ workspaceId: id }).catch(() => undefined)
        throw new CcwError(
          'workspace-registration-failed',
          `registered ${input.path} but could not set its title: ${messageOf(error)}`,
          { path: input.path, workspaceId: id },
          { cause: error },
        )
      }
    }
    return { id }
  }

  async rename(workspaceId: string, title: string): Promise<void> {
    await this.#controller.rename({ workspaceId, title })
  }

  async remove(workspaceId: string): Promise<void> {
    await this.#controller.delete({ workspaceId })
  }
}

/**
 * Used when the plugin runs without a DSH workspace controller (tests and the
 * standalone HTTP surface). It records no registration and reports
 * `available: false` so callers can surface that state instead of assuming
 * the sidebar was updated.
 */
export class UnregisteredWorkspaceRegistry implements WorkspaceRegistry {
  readonly available = false

  async register(): Promise<undefined> {
    return undefined
  }

  async rename(): Promise<void> {
    return undefined
  }

  async remove(): Promise<void> {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
