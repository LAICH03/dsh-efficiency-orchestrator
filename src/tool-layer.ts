/**
 * Tool layer: OPS publication, official-tool masking, and the frozen mapping table.
 *
 * The model-facing file tools are composed in one of two places, and this layer
 * has to handle both:
 *
 * - **Profile scope.** The TUI mounts `tool-fs` / `tool-fs-search` as host rows, so
 *   `read` / `glob` / `grep` are visible in the profile view. The layer publishes
 *   the OPS aliases there once and hides the official counterparts per Agent.
 * - **Agent (preset) scope.** The Web surface disables those host rows
 *   (`@deepseek-ai/dsh-web-app/cordis.patch.yml`) and lets each Agent preset mount
 *   them, so the profile view contains none of the three. The layer then publishes
 *   inside every Agent scope at `agent/created` — where the preset's registrations
 *   already exist and before the first prompt assembly — and hides the official
 *   counterparts in that same scope.
 *
 * Order of operations:
 *
 * 1. Probe the profile view read-only (`ctx.tools.get` / `definitions`). This is a
 *    pure query: no trial registration, no package-manager inspection.
 * 2. If an OPS provider already resolves the three anchor ids, reuse it, register
 *    nothing, and mask nothing.
 * 3. Otherwise publish. A profile-level publication is preferred while the official
 *    definitions are visible there; without them the layer publishes per Agent,
 *    capturing each Agent's own official definition so the alias keeps the
 *    parameters, output contract, renderer, presenters, concurrency classification,
 *    and timeout of the tool it replaces.
 * 4. Mask only what a visible alias backs. The official name is restricted in the
 *    scope that holds the alias; if the scoped registration fails, its mask is
 *    lifted again, so replacement can never remove a capability. Restrictions are
 *    scoped Cordis effects this layer disposes on Agent disposal and plugin unload,
 *    because the Agent fiber is not owned by this plugin.
 * 5. Freeze the profile-view mapping table once for the execution layer.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  agentsOf,
  isRecord,
  onAgentCreated,
  onAgentDisposed,
  scopedToolsOf,
  systemPromptOf,
  toolsOf,
  visibleToolOf,
  type HostToolDefinition,
  type HostToolResult,
  type HostTools,
} from './host.js'
import type { ResolvedOrchestratorConfig } from './config.js'
import {
  describeError,
  type SchedulerHost,
  type ToolMappingEntry,
  type ToolSource,
} from './types.js'

/** Official read-only tools and the OPS ids that replace them. */
export const OPS_TOOL_PAIRS = [
  { official: 'read', ops: 'ops_inspect_local_file' },
  { official: 'glob', ops: 'ops_glob' },
  { official: 'grep', ops: 'ops_grep' },
] as const

/** Official ids the layer may mask. */
export const OFFICIAL_TOOL_IDS: readonly string[] = OPS_TOOL_PAIRS.map(pair => pair.official)

/** OPS ids the layer publishes or detects. */
export const OPS_TOOL_IDS: readonly string[] = OPS_TOOL_PAIRS.map(pair => pair.ops)

/** System-prompt section naming the official tools that were replaced. */
export const TAKEOVER_SECTION_NAME = 'dsh-efficiency-orchestrator:tool-takeover'

/**
 * Placement inside this plugin's reserved block: batch policy `9550–9599`,
 * takeover notice `9600–9699`, session budget `9700–9799`.
 */
export const TAKEOVER_SECTION_ORDER = 9600

/**
 * Pick the read-only tool ids one scope can actually call.
 *
 * The OPS alias wins while it is visible; otherwise the official id is used.
 * Callers pass the Agent as the scope so a preset-composed Agent reports its own
 * tools instead of the profile view's (empty) set.
 *
 * @param tools - the `ctx.tools` registry handle.
 * @param scope - viewing scope (the Agent), or `undefined` for the profile view.
 * @param limit - maximum number of ids to return.
 * @returns visible ids in {@link OPS_TOOL_PAIRS} order, at most `limit`.
 */
export function visibleReadToolIds(tools: HostTools, scope: object | undefined, limit: number): string[] {
  if (limit <= 0) return []
  const ids: string[] = []
  for (const pair of OPS_TOOL_PAIRS) {
    if (visibleToolOf(tools, pair.ops, scope) !== undefined) {
      ids.push(pair.ops)
    } else if (visibleToolOf(tools, pair.official, scope) !== undefined) {
      ids.push(pair.official)
    }
  }
  return ids.slice(0, limit)
}

/** One official definition this layer can replace at profile scope. */
interface ProfileTarget {
  readonly pair: (typeof OPS_TOOL_PAIRS)[number]
  readonly definition: HostToolDefinition
}

/** What this layer registered and masked inside one Agent scope. */
interface AgentPublication {
  /** Disposers owned by this layer, in teardown order. */
  readonly disposers: Array<() => void>
  /** OPS ids this layer made visible in that Agent scope. */
  readonly published: Set<string>
  /** Official ids hidden for that Agent. */
  readonly hidden: Set<string>
}

/**
 * Tool-layer orchestrator for one Host lifetime.
 *
 * Both publication paths are Cordis effects; the profile-level registrations are
 * owned by this plugin's fiber, while the per-Agent ones belong to each Agent's
 * scoped context. Because the Agent fiber outlives this plugin, the layer keeps
 * every per-Agent disposer and releases it explicitly on Agent disposal and on
 * plugin unload.
 */
export class ToolLayer {
  private readonly ctx: Context
  private readonly scheduler: SchedulerHost
  private readonly config: ResolvedOrchestratorConfig
  /** OPS ids this layer registered at profile scope. */
  private readonly globalOps = new Set<string>()
  /** Profile-scope alias disposers, released explicitly on unload. */
  private readonly globalDisposers: Array<() => void> = []
  /** Per-Agent publication/mask state, keyed by the Agent object (its scope key). */
  private readonly agentStates = new Map<object, AgentPublication>()
  private tools: HostTools | undefined
  private started = false
  private mapInstalled = false
  private hooksInstalled = false
  private perAgentMode = false
  private perAgentReported = false
  private noticeInstalled = false
  private failureReported = false

  constructor(ctx: Context, scheduler: SchedulerHost, config: ResolvedOrchestratorConfig) {
    this.ctx = ctx
    this.scheduler = scheduler
    this.config = config
  }

  /**
   * Run the layer once.
   *
   * Failures are reported through the scheduler instead of escaping, so the rest
   * of the plugin keeps working; the mapping table is frozen on every path.
   */
  start(): void {
    if (this.started) return
    this.started = true
    // Agent- and profile-owned registrations are this layer's state; queue their
    // cleanup with the scheduler like every other self-owned buffer.
    this.scheduler.track(() => { this.disposeAll() })
    let failure: unknown
    try {
      this.mount()
    } catch (error) {
      failure = error
    }
    if (!this.mapInstalled) this.freezeMap(new Map(), 'self')
    if (failure !== undefined) {
      this.scheduler.updateStatus('tools', 'failed', describeError(failure))
      this.scheduler.diagnostic('warn', 'tools', `tool layer failed: ${describeError(failure)}`)
    }
  }

  /** Probe, resolve the provider, publish, mask, then freeze. */
  private mount(): void {
    const tools = toolsOf(this.ctx)
    this.tools = tools
    if (tools === undefined) {
      this.scheduler.updateStatus('tools', 'unavailable', 'ctx.tools is not mounted')
      this.scheduler.diagnostic('warn', 'tools', 'ctx.tools is unavailable; tool layer disabled')
      return
    }

    // 1) Read-only probe. The aliases delegate to the official definitions, so a
    // Host without any read-only query cannot be replaced safely; stay read-only.
    if (typeof tools.get !== 'function' && typeof tools.definitions !== 'function') {
      this.scheduler.updateStatus('tools', 'unavailable', 'ctx.tools exposes no read-only query')
      this.scheduler.diagnostic(
        'warn',
        'tools',
        'ctx.tools exposes no read-only query; OPS aliases cannot be built and official tools stay visible',
      )
      return
    }

    const profileView = this.readVisible()
    const externalOps = OPS_TOOL_IDS.filter(id => profileView.has(id))
    if (externalOps.length > 0) {
      this.reuseExternal(externalOps)
      return
    }

    const targets: ProfileTarget[] = []
    for (const pair of OPS_TOOL_PAIRS) {
      const definition = profileView.get(pair.official)
      if (definition === undefined) continue
      targets.push({ pair, definition })
    }

    if (targets.length > 0) {
      if (!this.publishAtProfile(targets)) return
      this.scheduler.updateStatus(
        'tools',
        'active',
        `profile scope: registered ${this.globalOps.size} OPS alias(es); per-Agent masking armed`,
      )
      this.scheduler.diagnostic(
        'info',
        'tools',
        `OPS tools self-registered at profile scope (${[...this.globalOps].join(', ')}); per-Agent masking armed for official `
          + `${OPS_TOOL_PAIRS.filter(pair => this.globalOps.has(pair.ops)).map(pair => pair.official).join(', ')}`,
      )
    } else {
      // No official definition in the profile view: the surface (Web/Desktop)
      // composes the file tools per Agent preset. Publication therefore has to
      // happen in each Agent scope; the hooks below do exactly that.
      this.perAgentMode = true
      this.scheduler.updateStatus(
        'tools',
        'active',
        'profile view holds no read/glob/grep; per-Agent OPS takeover armed',
      )
      this.scheduler.diagnostic(
        'info',
        'tools',
        'profile scope exposes none of "read"/"glob"/"grep" (a preset-composed surface such as Web); '
          + 'OPS publication runs inside each Agent scope instead of the profile scope',
      )
    }

    this.installAgentHooks()
  }

  /** Reuse an already-resolved OPS provider without any registration call. */
  private reuseExternal(externalOps: readonly string[]): void {
    const missing = OPS_TOOL_IDS.filter(id => !externalOps.includes(id))
    if (missing.length === 0) {
      this.scheduler.updateStatus('tools', 'active', 'external-ops')
      this.scheduler.diagnostic(
        'info',
        'tools',
        `OPS tools already resolved (${externalOps.join(', ')}); reusing them without registration or masking`,
      )
    } else {
      this.scheduler.updateStatus('tools', 'unavailable', `external-ops partial; missing ${missing.join(', ')}`)
      this.scheduler.diagnostic(
        'warn',
        'tools',
        `partial external OPS provider: missing ${missing.join(', ')}; no registration attempted`,
      )
    }
    const sources = new Map<string, ToolSource>()
    for (const id of externalOps) sources.set(id, 'external-ops')
    this.freezeMap(sources, 'external-ops')
  }

  /**
   * Register this plugin's OPS aliases at profile scope.
   *
   * @param targets - official definitions visible in the profile view.
   * @returns `true` when at least one alias is registered; `false` when the layer
   * yielded to an existing implementation (conflict) and must not mask anything.
   */
  private publishAtProfile(targets: readonly ProfileTarget[]): boolean {
    const tools = this.tools
    if (tools === undefined) return false
    const disposers: Array<() => void> = []
    const registered = new Set<string>()
    try {
      for (const target of targets) {
        const dispose = tools.register(aliasDefinition(target.pair.ops, target.definition))
        disposers.push(dispose)
        registered.add(target.pair.ops)
      }
    } catch (error) {
      // Conflict (or any registration rejection): yield. Roll back only what this
      // attempt created, re-probe read-only, mark `external-ops` when it resolves,
      // and never retry.
      let dispose = disposers.pop()
      while (dispose !== undefined) {
        try {
          dispose()
        } catch {
          // The rollback disposer was already released by Cordis; nothing to do.
        }
        dispose = disposers.pop()
      }
      registered.clear()

      const visibleNow = this.readVisible()
      const externalNow = OPS_TOOL_IDS.filter(id => visibleNow.has(id))
      const reason = `OPS registration conflicted (${describeError(error)}); yielded to the existing implementation without retry`
      if (externalNow.length === OPS_TOOL_IDS.length) {
        this.scheduler.updateStatus('tools', 'active', 'external-ops (yielded after conflict)')
      } else {
        this.scheduler.updateStatus('tools', 'unavailable', reason)
      }
      this.scheduler.diagnostic('warn', 'tools', reason)

      const sources = new Map<string, ToolSource>()
      for (const id of externalNow) sources.set(id, 'external-ops')
      this.freezeMap(sources, 'external-ops')
      return false
    }

    for (const dispose of disposers) this.globalDisposers.push(dispose)
    for (const id of registered) this.globalOps.add(id)
    this.installTakeoverNotice()
    return true
  }

  /**
   * Arm publication and masking for every live and future Agent.
   *
   * `agent/created` is dispatched after the Agent preset finished mounting and
   * before the first prompt assembly, so registrations made in its listeners are
   * part of the Agent's first tool declaration set. A profile-level plugin has no
   * Agent scope of its own, so `ctx.tools.restrict()` called on it is rejected by
   * the Host; restricting through `agent.ctx.tools` is the supported inverse.
   */
  private installAgentHooks(): void {
    if (this.hooksInstalled) return
    this.hooksInstalled = true

    onAgentCreated(this.ctx, ({ agent }) => {
      // Inside agent creation: a throw here would abort Agent creation, so
      // takeover failures are contained like any other host rejection.
      try {
        this.applyToAgent(agent)
      } catch (error) {
        this.reportFailure(`agent/created handler: ${describeError(error)}`)
      }
    })
    onAgentDisposed(this.ctx, ({ agent }) => {
      try {
        this.releaseAgent(agent)
      } catch (error) {
        this.scheduler.diagnostic('debug', 'tools', `agent/disposed takeover cleanup failed: ${describeError(error)}`)
      }
    })

    const agents = agentsOf(this.ctx)
    if (agents === undefined || typeof agents.list !== 'function') {
      this.scheduler.diagnostic(
        'debug',
        'tools',
        'agents service unavailable; OPS takeover applies as Agents are created',
      )
      return
    }
    let existing: readonly unknown[]
    try {
      existing = agents.list()
    } catch (error) {
      this.scheduler.diagnostic('warn', 'tools', `cannot enumerate live agents for the OPS takeover: ${describeError(error)}`)
      return
    }
    let applied = 0
    for (const agent of existing) {
      if (this.applyToAgent(agent)) applied += 1
    }
    this.scheduler.diagnostic('debug', 'tools', `OPS takeover applied to ${applied} existing agent(s)`)
  }

  /**
   * Publish and mask for one Agent, once.
   *
   * @param agent - the Agent object, which is also its scope key.
   * @returns `true` when this call changed the Agent's tool view.
   */
  private applyToAgent(agent: unknown): boolean {
    if (!this.hooksInstalled || !this.scheduler.isRunning() || !isRecord(agent)) return false
    const key = agent as object
    if (this.agentStates.has(key)) return false
    if (this.globalOps.size > 0) return this.maskForProfileAliases(key, agent)
    return this.publishForAgent(key, agent)
  }

  /**
   * Ask whether one Agent sees a tool.
   *
   * The Agent object is passed as the Host query's explicit viewing scope. It is
   * deliberately NOT read from a `scopedTools.get()` call: only `register()` and
   * `restrict()` bind a scope through the caller context, while `get()` /
   * `definitions()` default to the profile view when the argument is omitted.
   *
   * @param name - tool id to resolve.
   * @param agentScope - the Agent object, which is also its scope key.
   * @returns the definition that Agent sees, or `undefined`.
   */
  private visibleInAgent(name: string, agentScope: object): HostToolDefinition | undefined {
    const tools = this.tools
    return tools === undefined ? undefined : visibleToolOf(tools, name, agentScope)
  }

  /**
   * Hide the official counterparts of aliases registered at profile scope.
   *
   * Replacement is gated per Agent on the OPS alias actually being visible in that
   * Agent's scope, so an alias published at profile scope never strips a tool an
   * Agent does not have.
   */
  private maskForProfileAliases(key: object, agent: unknown): boolean {
    const scoped = scopedToolsOf(agentCtxOf(agent))
    if (scoped === undefined) {
      this.reportFailure('the Agent context exposes no scoped tools registry')
      return false
    }

    const deny: string[] = []
    for (const pair of OPS_TOOL_PAIRS) {
      if (!this.globalOps.has(pair.ops)) continue
      if (this.visibleInAgent(pair.ops, key) === undefined) continue
      if (this.visibleInAgent(pair.official, key) === undefined) continue
      deny.push(pair.official)
    }
    if (deny.length === 0) {
      this.scheduler.diagnostic(
        'debug',
        'tools',
        `masking skipped for agent ${agentId(agent)}: no profile-scope OPS alias is visible in that scope`,
      )
      return false
    }

    const publication: AgentPublication = { disposers: [], published: new Set(), hidden: new Set() }
    for (const official of deny) {
      try {
        publication.disposers.push(scoped.restrict({ deny: [official] }))
        publication.hidden.add(official)
      } catch (error) {
        this.reportFailure(`agent ${agentId(agent)} "${official}": ${describeError(error)}`)
      }
    }
    if (publication.disposers.length === 0) return false

    this.agentStates.set(key, publication)
    this.scheduler.diagnostic(
      'debug',
      'tools',
      `forced replacement: official ${[...publication.hidden].join(', ')} hidden for agent ${agentId(agent)}`,
    )
    return true
  }

  /**
   * Publish this plugin's OPS aliases inside one Agent scope.
   *
   * Used when the profile view holds no official definition (Web/preset surfaces).
   * The official definition is captured from the Agent's own view, the alias is
   * registered in the Agent's scope, and the official name is restricted in that
   * same scope. A mask that no visible alias backs is always lifted again.
   */
  private publishForAgent(key: object, agent: unknown): boolean {
    const scoped = scopedToolsOf(agentCtxOf(agent))
    if (scoped === undefined) {
      this.reportFailure('the Agent context exposes no scoped tools registry')
      return false
    }

    const publication: AgentPublication = { disposers: [], published: new Set(), hidden: new Set() }
    const absent: string[] = []
    let external = 0

    for (const pair of OPS_TOOL_PAIRS) {
      if (this.visibleInAgent(pair.ops, key) !== undefined) {
        external += 1
        continue
      }
      const official = this.visibleInAgent(pair.official, key)
      if (official === undefined) {
        absent.push(pair.official)
        continue
      }

      // Apply the mask first: `restrict()` rejects a name it cannot mask (a
      // scope-local registration), and an unmaskable official tool must keep its
      // name instead of gaining a duplicate alias.
      let liftMask: (() => void) | undefined
      try {
        liftMask = scoped.restrict({ deny: [pair.official] })
      } catch (error) {
        this.scheduler.diagnostic(
          'debug',
          'tools',
          `agent ${agentId(agent)}: cannot mask "${pair.official}" (${describeError(error)}); `
            + `"${pair.ops}" stays unpublished so no duplicate read path appears`,
        )
        continue
      }

      let dispose: (() => void) | undefined
      try {
        dispose = scoped.register(aliasDefinition(pair.ops, official))
        // Trust but verify through the same scope-aware query: the alias must be
        // visible to THIS Agent and the official name must be gone. A Host whose
        // query ignored the scope argument would fail here instead of silently
        // leaving the Agent with the old tool set.
        if (this.visibleInAgent(pair.ops, key) === undefined
          || this.visibleInAgent(pair.official, key) !== undefined) {
          throw new Error('the scoped registration did not take effect in the Agent scope')
        }
        publication.disposers.push(dispose, liftMask)
        publication.published.add(pair.ops)
        publication.hidden.add(pair.official)
      } catch (error) {
        // Keep the capability: remove any alias and lift the mask that no visible
        // alias now backs.
        try {
          dispose?.()
        } catch {
          // The Agent fiber already released the registration; nothing to undo.
        }
        try {
          liftMask()
        } catch {
          // The Agent fiber already released the restriction; nothing to lift.
        }
        this.scheduler.diagnostic(
          'warn',
          'tools',
          `agent ${agentId(agent)}: "${pair.ops}" registration failed (${describeError(error)}); `
            + `"${pair.official}" restored`,
        )
      }
    }

    if (publication.published.size === 0) {
      this.scheduler.diagnostic(
        'debug',
        'tools',
        `agent ${agentId(agent)}: no OPS alias published (external ${external}; absent ${absent.join(', ') || 'none'})`,
      )
      return false
    }

    this.agentStates.set(key, publication)
    this.installTakeoverNotice()
    if (!this.perAgentReported) {
      this.perAgentReported = true
      this.scheduler.updateStatus(
        'tools',
        'active',
        `per-Agent OPS takeover active: ${publication.published.size} alias(es) in the newest Agent scope`,
      )
      this.scheduler.diagnostic(
        'info',
        'tools',
        `per-Agent OPS takeover: registered ${[...publication.published].join(', ')} and hid `
          + `${[...publication.hidden].join(', ')} for agent ${agentId(agent)}`,
      )
    } else {
      this.scheduler.diagnostic(
        'debug',
        'tools',
        `agent ${agentId(agent)}: registered ${[...publication.published].join(', ')}; `
          + `hid ${[...publication.hidden].join(', ')}`,
      )
    }
    return true
  }

  /**
   * Register the conditional "official tools are disabled" notice.
   *
   * The section is registered once, only after a takeover actually succeeded,
   * and its text is resolved per assembly: an Agent that still sees an official
   * name (different preset, external provider, failed takeover) renders nothing.
   * Empty text is dropped by the prompt renderer, so the notice never leaks into
   * a scope that was not taken over.
   */
  private installTakeoverNotice(): void {
    if (this.noticeInstalled || !this.config.toolLayer.warning) return
    const prompt = systemPromptOf(this.ctx)
    if (prompt === undefined) {
      this.scheduler.diagnostic('debug', 'tools', 'systemPrompt unavailable; tool takeover notice not injected')
      return
    }
    try {
      prompt.section({
        name: TAKEOVER_SECTION_NAME,
        order: TAKEOVER_SECTION_ORDER,
        text: context => this.takeoverNotice(context.agent),
      })
    } catch (error) {
      this.scheduler.diagnostic('warn', 'tools', `tool takeover notice registration failed: ${describeError(error)}`)
      return
    }
    this.noticeInstalled = true
    this.scheduler.diagnostic(
      'debug',
      'tools',
      `tool takeover notice registered (order ${TAKEOVER_SECTION_ORDER}, conditional per Agent)`,
    )
  }

  /**
   * Build the takeover notice for one assembly.
   *
   * Fires only for an Agent that actually lost an official tool and gained its
   * OPS alias, so the model is never told about a replacement it cannot use.
   *
   * @param agent - Agent of the assembly being rendered, when the Host supplies it.
   * @returns the warning text, or `''` when this Agent was not taken over.
   */
  private takeoverNotice(agent: unknown): string {
    if (!isRecord(agent)) return ''
    const replaced: Array<{ official: string; ops: string }> = []
    for (const pair of OPS_TOOL_PAIRS) {
      if (this.visibleInAgent(pair.ops, agent) === undefined) continue
      if (this.visibleInAgent(pair.official, agent) !== undefined) continue
      replaced.push(pair)
    }
    if (replaced.length === 0) return ''
    const officials = replaced.map(pair => `\`${pair.official}\``).join(' / ')
    const aliases = replaced.map(pair => `\`${pair.ops}\``).join(' / ')
    return `⚠️ 工具替换：官方 ${officials} 工具已被禁用，请直接使用 ${aliases} 进行读取与搜索；不要调用已禁用的官方工具名。`
  }

  /** Lift and forget one Agent's takeover; its own disposal is idempotent. */
  private releaseAgent(agent: unknown): void {
    if (!isRecord(agent)) return
    const key = agent as object
    const publication = this.agentStates.get(key)
    if (publication === undefined) return
    this.agentStates.delete(key)
    this.disposePublication(publication)
  }

  /** Lift every per-Agent takeover; called from the scheduler's serial teardown. */
  private disposeAll(): void {
    const publications = [...this.agentStates.values()]
    this.agentStates.clear()
    for (const publication of publications) this.disposePublication(publication)

    const globals = [...this.globalDisposers]
    this.globalDisposers.length = 0
    for (const dispose of globals) this.safeDispose(dispose)
    this.globalOps.clear()
  }

  private disposePublication(publication: AgentPublication): void {
    for (const dispose of publication.disposers) this.safeDispose(dispose)
    publication.disposers.length = 0
  }

  private safeDispose(dispose: () => void): void {
    try {
      dispose()
    } catch (error) {
      this.scheduler.diagnostic('debug', 'tools', `failed to dispose an OPS takeover effect: ${describeError(error)}`)
    }
  }

  /**
   * Report one takeover failure without turning it into a fiber failure.
   *
   * Constraint: replacement must never crash the plugin or conflict with an
   * existing registration. A failure here leaves already-published OPS tools
   * working; the official tool simply stays visible for that Agent.
   */
  private reportFailure(message: string): void {
    if (this.failureReported) {
      this.scheduler.diagnostic('debug', 'tools', `OPS takeover failure: ${message}`)
      return
    }
    this.failureReported = true
    this.scheduler.diagnostic(
      'warn',
      'tools',
      `OPS takeover could not replace an official tool for an agent (${message}); published OPS tools remain active`,
    )
  }

  /** Read the visible profile-scope definitions without changing anything. */
  private readVisible(): Map<string, HostToolDefinition> {
    const tools = this.tools
    const visible = new Map<string, HostToolDefinition>()
    if (tools === undefined) return visible
    if (typeof tools.definitions === 'function') {
      for (const definition of tools.definitions()) {
        if (definition !== null && typeof definition.name === 'string') {
          visible.set(definition.name, definition)
        }
      }
      return visible
    }
    // Enumeration missing: probe only the ids this layer reasons about.
    for (const id of [...OFFICIAL_TOOL_IDS, ...OPS_TOOL_IDS]) {
      const definition = visibleToolOf(tools, id)
      if (definition !== undefined) visible.set(id, definition)
    }
    return visible
  }

  /**
   * Build and freeze the tool mapping table.
   *
   * Every profile-visible tool becomes a `visible: true` entry; the official
   * anchors and the OPS anchors that are absent become `visible: false` entries so
   * the execution layer never suggests a tool the plugin actually hid or never
   * mounted. The execution layer resolves per-Agent hints from the live registry
   * and uses this table only when no Agent is in context (for example an
   * agent-less prompt preview).
   */
  private freezeMap(opsSources: ReadonlyMap<string, ToolSource>, fallbackOpsSource: ToolSource): void {
    if (this.mapInstalled) return
    const visible = this.readVisible()
    const entries = new Map<string, ToolMappingEntry>()
    for (const name of visible.keys()) {
      entries.set(name, { visible: true, source: this.sourceOf(name, opsSources, fallbackOpsSource) })
    }
    for (const id of OFFICIAL_TOOL_IDS) {
      if (!entries.has(id)) entries.set(id, { visible: false, source: 'official' })
    }
    for (const id of OPS_TOOL_IDS) {
      if (!entries.has(id)) {
        entries.set(id, { visible: false, source: opsSources.get(id) ?? fallbackOpsSource })
      }
    }
    const sorted = [...entries.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    this.scheduler.installToolMap(sorted)
    this.mapInstalled = true
    this.scheduler.diagnostic('debug', 'tools', `tool mapping table frozen (${sorted.length} entries)`)
  }

  /** Classify one visible tool for the mapping table. */
  private sourceOf(name: string, opsSources: ReadonlyMap<string, ToolSource>, fallbackOpsSource: ToolSource): ToolSource {
    const known = opsSources.get(name)
    if (known !== undefined) return known
    // Any other `ops_*` provider is external; everything else is Host-owned.
    return name.startsWith('ops_') ? fallbackOpsSource : 'official'
  }
}

/**
 * Build an OPS alias over one captured official definition.
 *
 * The alias keeps the official parameters, output schema, renderer, presenters,
 * concurrency classification, and timeout, and forwards execution to the same
 * body. Only the model-facing name changes, so masking the official tool never
 * removes a capability — it renames it.
 */
function aliasDefinition(name: string, source: HostToolDefinition): HostToolDefinition {
  const isConcurrencySafe = source.isConcurrencySafe
  const timeoutMs = source.timeoutMs
  const projectContent = source.projectContent
  const finalizeContent = source.finalizeContent
  const presentCall = source.presentCall
  const presentResult = source.presentResult
  return {
    name,
    description: source.description,
    parameters: source.parameters,
    output: source.output,
    execute: (args, exec) => source.execute(args, exec),
    ...(source.deferLoading === true ? { deferLoading: true as const } : {}),
    ...(isConcurrencySafe === undefined ? {} : {
      isConcurrencySafe: (args: unknown) => isConcurrencySafe(args),
    }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(projectContent === undefined ? {} : {
      projectContent: (exec: unknown, result: unknown) => projectContent(exec, result),
    }),
    ...(finalizeContent === undefined ? {} : {
      finalizeContent: (exec: unknown, result: unknown) => finalizeContent(exec, result),
    }),
    ...(presentCall === undefined ? {} : {
      presentCall: (args: unknown) => presentCall(args),
    }),
    ...(presentResult === undefined ? {} : {
      presentResult: (args: unknown, result: HostToolResult) => presentResult(args, result),
    }),
  }
}

/** Read one Agent's scoped context, tolerating live shapes. */
function agentCtxOf(agent: unknown): unknown {
  return isRecord(agent) ? agent.ctx : undefined
}

/** Best-effort Agent identity for diagnostics. */
function agentId(agent: unknown): string {
  return isRecord(agent) && typeof agent.id === 'string' ? agent.id : '?'
}
