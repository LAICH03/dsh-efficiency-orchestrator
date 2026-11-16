/**
 * dsh-efficiency-orchestrator — Host entrypoint and internal scheduler.
 *
 * The plugin coordinates four round/step efficiency capabilities in one Host
 * lifetime: a tool layer, a streaming reasoning loop breaker, execution-time
 * batch suggestions, and a session budget guard.
 *
 * `apply` never wires a sub-feature directly. It starts {@link OrchestratorScheduler},
 * which owns the lifecycle state machine, the tool mapping table, the
 * truncation/compaction/budget marks, and a serial resource manager. Layers mount
 * inside `start()`, so both the mount order and every registration's lifecycle
 * live in one place instead of being spread across `apply`.
 *
 * Mount order (Cordis lifecycle makes it authoritative):
 * 1. `tools` — registers/detects OPS tools, installs per-Agent forced
 *    replacement, and freezes the mapping table.
 * 2. `streaming` — `llm/stream` reasoning guard.
 * 3. `execution` — static batch section (after the table is frozen) plus the
 *    `agent/pre-step` notice hook.
 * 4. `session` — static budget section plus the counter/hard-stop hook.
 */
import type { Context, Inject } from '@deepseek-ai/cordis'
import {
  resolveConfig,
  type OrchestratorConfig,
  type ResolvedOrchestratorConfig,
} from './config.js'
import { ExecutionLayer } from './execution-layer.js'
import { SessionLayer } from './session-layer.js'
import { StreamingLayer } from './streaming-layer.js'
import { ToolLayer } from './tool-layer.js'
import {
  SUBSYSTEM_IDS,
  describeError,
  type DiagnosticLevel,
  type OrchestratorDiagnostic,
  type SchedulerHost,
  type SchedulerLifecycle,
  type SubsystemId,
  type SubsystemState,
  type SubsystemStatus,
  type ToolMap,
  type ToolMappingEntry,
} from './types.js'

/** Plugin name shown in fiber diagnostics and log lines. */
export const name = 'dsh-efficiency-orchestrator'

/**
 * Hard service dependencies used by the sub-modules.
 *
 * Only services that `apply` cannot work without belong here: while any of them
 * is missing Cordis keeps the fiber `PENDING`, so `apply` never runs and the
 * plugin never starts half-wired. Optional capabilities must NOT be listed —
 * probe them with `ctx.get(...)` inside the layers instead, so that a missing
 * optional service disables only its own sub-feature and the fiber stays
 * `ACTIVE`.
 */
const REQUIRED_SERVICES = ['systemPrompt', 'tools', 'llm'] as const

/** Cordis dependency declaration (array form is a mutable array, not a tuple). */
export const inject: Inject = [...REQUIRED_SERVICES]

/** Bounded diagnostic ring buffer: enough for diagnostics and tests, not a log. */
const MAX_DIAGNOSTICS = 200

/** Session keys retained by the scheduler-owned marks; oldest key is evicted. */
const MAX_TRACKED_SESSIONS = 64

export { BATCH_SECTION_NAME, resolveConfig, SESSION_SECTION_NAME } from './config.js'
export type {
  BatchPolicyConfig,
  ExecutionConfig,
  OrchestratorConfig,
  ResolvedOrchestratorConfig,
  SessionConfig,
} from './config.js'
export { SUBSYSTEM_IDS }
export type {
  DiagnosticLevel,
  OrchestratorDiagnostic,
  SchedulerHost,
  SchedulerLifecycle,
  SubsystemId,
  SubsystemState,
  SubsystemStatus,
  ToolMap,
  ToolMappingEntry,
  ToolSource,
} from './types.js'

/** Normalize a session id into a map key (empty ids are still distinct). */
function sessionKey(sessionId: string): string {
  return sessionId.length > 0 ? sessionId : '(no-session)'
}

/**
 * Serial, LIFO cleanup queue owned by the scheduler.
 *
 * Cordis runs sibling effect disposers concurrently, so any cleanup with an
 * ordering dependency must not be spread across several effects. Everything the
 * scheduler owns itself — timers, temporary buffers, watchers, and any direct
 * mutation of global state that Cordis does not track — is queued here and
 * drained by the single disposer that `apply` hands to `ctx.effect`. A failing
 * step is reported and does not abort the rest of the queue.
 */
class ResourceManager {
  private readonly disposers: Array<() => void | Promise<void>> = []

  /** Queue one cleanup step; steps drain in reverse registration order. */
  track(dispose: () => void | Promise<void>): void {
    this.disposers.push(dispose)
  }

  /** Drain the queue serially; teardown continues even if one step throws. */
  async disposeAll(onError: (error: unknown) => void): Promise<void> {
    let dispose = this.disposers.pop()
    while (dispose !== undefined) {
      try {
        await dispose()
      } catch (error) {
        onError(error)
      }
      dispose = this.disposers.pop()
    }
  }
}

/**
 * Internal scheduler: the single owner of the four sub-features.
 *
 * It owns
 *
 * - the per-sub-feature lifecycle state machine, so enablement, ordering, and
 *   yield decisions stay in one place;
 * - the resource manager that collects the scheduler's own disposers into one
 *   serial teardown, so fiber unload during a plugin reload is exact;
 * - the frozen tool mapping table that the execution layer reads read-only;
 * - the lightweight causal marks: truncated reasoning, pending compaction
 *   notices, and exceeded session budgets.
 *
 * Startup is asynchronous only because the execution layer's conflict probe is a
 * read-only `systemPrompt.assemble()`. `start()` keeps the synchronous contract
 * and exposes {@link whenStarted} for tests; `stop()` awaits the same startup
 * promise so an unload mid-mount still yields an exact, serial teardown.
 */
export class OrchestratorScheduler implements SchedulerHost {
  private readonly ctx: Context
  private readonly config: ResolvedOrchestratorConfig
  private readonly resources = new ResourceManager()
  private readonly statuses: Record<SubsystemId, SubsystemStatus> = {
    tools: { id: 'tools', state: 'idle' },
    streaming: { id: 'streaming', state: 'idle' },
    execution: { id: 'execution', state: 'idle' },
    session: { id: 'session', state: 'idle' },
  }
  private readonly diagnostics: OrchestratorDiagnostic[] = []
  private readonly truncatedSessions = new Map<string, number>()
  private readonly compactionPending = new Map<string, number>()
  private readonly budgetExceeded = new Map<string, string>()
  private frozenToolMap: ToolMap | undefined
  private lifecycle: SchedulerLifecycle = 'created'
  private startup: Promise<void> | undefined

  constructor(ctx: Context, config: ResolvedOrchestratorConfig = resolveConfig(undefined)) {
    this.ctx = ctx
    this.config = config
  }

  /** The scheduler's current lifecycle stage. */
  get state(): SchedulerLifecycle {
    return this.lifecycle
  }

  /** The frozen tool mapping table; throws until the tool layer settles. */
  get toolMap(): ToolMap {
    if (this.frozenToolMap === undefined) throw new Error('tool mapping table is not available')
    return this.frozenToolMap
  }

  /** Detached copy of the retained diagnostics, oldest first. */
  get diagnosticLog(): readonly OrchestratorDiagnostic[] {
    return [...this.diagnostics]
  }

  /**
   * Enter the running state and start mounting the sub-modules in dependency order.
   *
   * The returned promise is tracked as {@link whenStarted}; `stop()` awaits it so
   * an unload during the asynchronous conflict probe cannot leak registrations.
   */
  start(): void {
    if (this.lifecycle !== 'created') return
    this.lifecycle = 'running'
    // Definitionally unreachable unless a layer breaks its own containment; the
    // catch keeps a future bug from surfacing as an unhandled rejection and still
    // lets `stop()` proceed through the serial teardown.
    this.startup = this.mountAll().catch((error) => {
      this.diagnostic('warn', 'scheduler', `startup failed: ${describeError(error)}`)
    })
  }

  /** Resolve once every sub-module finished its mount attempt. */
  async whenStarted(): Promise<void> {
    await this.startup
  }

  /** Whether the scheduler is still mounting or running (late async mounts check it). */
  isRunning(): boolean {
    return this.lifecycle === 'running'
  }

  /** Mount every enabled sub-module in dependency order. */
  private async mountAll(): Promise<void> {
    const config = this.config
    if (config.toolLayer.enabled) {
      await this.mount('tools', () => new ToolLayer(this.ctx, this).start())
    } else {
      this.updateStatus('tools', 'disabled', 'tool layer disabled by config')
      this.diagnostic('debug', 'scheduler', 'tool layer disabled by config')
    }
    if (config.streaming.enabled) {
      await this.mount('streaming', () => new StreamingLayer(this.ctx, this).start())
    } else {
      this.updateStatus('streaming', 'disabled', 'streaming layer disabled by config')
      this.diagnostic('debug', 'scheduler', 'streaming layer disabled by config')
    }
    await this.mount('execution', () => new ExecutionLayer(this.ctx, this, config).start())
    await this.mount('session', () => new SessionLayer(this.ctx, this, config).start())
  }

  /**
   * Shut every sub-feature down and drain the resource queue serially.
   *
   * Called exactly once by the disposer that `apply` registers with
   * `ctx.effect`; Cordis awaits the returned promise during unload. Listener,
   * tool, and restriction registrations are Cordis effects and are lifted by the
   * fiber itself; this method only tears down scheduler-owned state.
   */
  async stop(): Promise<void> {
    if (this.lifecycle === 'stopping' || this.lifecycle === 'stopped') return
    this.lifecycle = 'stopping'
    if (this.startup !== undefined) {
      try {
        // A late mount checks `isRunning()` before registering, so awaiting this
        // here both joins the in-flight probe and keeps teardown serial.
        await this.startup
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
    for (const id of SUBSYSTEM_IDS) {
      this.statuses[id].state = 'stopped'
    }
    this.truncatedSessions.clear()
    this.compactionPending.clear()
    this.budgetExceeded.clear()
    await this.resources.disposeAll((error) => this.ctx.logger.error(error))
    this.frozenToolMap = undefined
    this.lifecycle = 'stopped'
  }

  /** Queue a scheduler-owned cleanup step; see {@link ResourceManager}. */
  track(dispose: () => void | Promise<void>): void {
    this.resources.track(dispose)
  }

  /** Internal state-machine entry used by the sub-modules when mounting. */
  updateStatus(id: SubsystemId, state: SubsystemState, reason?: string): void {
    const status = this.statuses[id]
    status.state = state
    if (reason === undefined) {
      delete status.reason
    } else {
      status.reason = reason
    }
  }

  /** Whether the tool layer already froze the mapping table. */
  hasToolMap(): boolean {
    return this.frozenToolMap !== undefined
  }

  /**
   * Freeze the tool mapping table published by the tool layer.
   *
   * Entries are copied and frozen, mutation methods are replaced with throwing
   * stubs, and the `ReadonlyMap` type is the only surface consumers receive.
   * May be called once per scheduler lifetime.
   */
  installToolMap(entries: Iterable<readonly [string, ToolMappingEntry]>): void {
    if (this.frozenToolMap !== undefined) throw new Error('tool mapping table is already frozen')
    const frozen = new Map<string, ToolMappingEntry>()
    for (const [id, entry] of entries) {
      frozen.set(id, Object.freeze({ visible: entry.visible, source: entry.source }))
    }
    Object.defineProperties(frozen, {
      set: {
        enumerable: false,
        value: () => { throw new Error('the tool mapping table is frozen') },
      },
      delete: {
        enumerable: false,
        value: () => { throw new Error('the tool mapping table is frozen') },
      },
      clear: {
        enumerable: false,
        value: () => { throw new Error('the tool mapping table is frozen') },
      },
    })
    Object.freeze(frozen)
    this.frozenToolMap = frozen as unknown as ToolMap
  }

  /**
   * Mark that one reasoning block of this session was truncated in-stream.
   *
   * The mark is lightweight on purpose: it only records that truncation happened
   * (and how many times), not the reasoning text itself. The execution layer's
   * `pre-step` hook consumes it before emitting any batch suggestion.
   */
  markReasoningTruncated(sessionId: string): void {
    const key = sessionKey(sessionId)
    const current = this.truncatedSessions.get(key)
    if (current !== undefined) {
      this.truncatedSessions.set(key, current + 1)
      return
    }
    if (this.truncatedSessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.truncatedSessions.keys().next()
      if (!oldest.done) this.truncatedSessions.delete(oldest.value)
    }
    this.truncatedSessions.set(key, 1)
  }

  /** How many truncations are pending for this session. */
  reasoningTruncatedCount(sessionId: string): number {
    return this.truncatedSessions.get(sessionKey(sessionId)) ?? 0
  }

  /**
   * Read and clear the truncation mark of this session.
   *
   * @returns `true` when at least one truncation happened and the mark is now
   * cleared, so the caller consumes it exactly once.
   */
  consumeReasoningTruncation(sessionId: string): boolean {
    const key = sessionKey(sessionId)
    if (!this.truncatedSessions.has(key)) return false
    this.truncatedSessions.delete(key)
    return true
  }

  /** Record a successful compaction whose notice awaits the next step. */
  markCompactionPending(sessionId: string): void {
    const key = sessionKey(sessionId)
    const current = this.compactionPending.get(key)
    if (current !== undefined) {
      this.compactionPending.set(key, current + 1)
      return
    }
    if (this.compactionPending.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.compactionPending.keys().next()
      if (!oldest.done) this.compactionPending.delete(oldest.value)
    }
    this.compactionPending.set(key, 1)
  }

  /** Whether a compaction notice is pending for this session. */
  hasCompactionPending(sessionId: string): boolean {
    return this.compactionPending.has(sessionKey(sessionId))
  }

  /** Consume the pending compaction notice exactly once. */
  consumeCompactionPending(sessionId: string): boolean {
    const key = sessionKey(sessionId)
    if (!this.compactionPending.has(key)) return false
    this.compactionPending.delete(key)
    return true
  }

  /** Record that this session's budget was exceeded (bounded scheduler state). */
  noteBudgetExceeded(sessionId: string, detail: string): void {
    const key = sessionKey(sessionId)
    if (!this.budgetExceeded.has(key) && this.budgetExceeded.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.budgetExceeded.keys().next()
      if (!oldest.done) this.budgetExceeded.delete(oldest.value)
    }
    this.budgetExceeded.set(key, detail)
  }

  /** Whether the session's budget was exceeded. */
  isBudgetExceeded(sessionId: string): boolean {
    return this.budgetExceeded.has(sessionKey(sessionId))
  }

  /** Detached copy of one sub-feature's status, for diagnostics. */
  statusOf(id: SubsystemId): SubsystemStatus {
    return { ...this.statuses[id] }
  }

  /** Detached copy of every sub-feature status, in {@link SUBSYSTEM_IDS} order. */
  snapshot(): SubsystemStatus[] {
    return SUBSYSTEM_IDS.map((id) => ({ ...this.statuses[id] }))
  }

  /** Record and log one diagnostic; the retained log is bounded. */
  diagnostic(level: DiagnosticLevel, scope: string, message: string): void {
    this.diagnostics.push({ at: Date.now(), level, scope, message })
    if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift()
    if (level === 'warn') {
      this.ctx.logger.warn('[%s] %s', scope, message)
    } else if (level === 'info') {
      this.ctx.logger.info('[%s] %s', scope, message)
    } else {
      this.ctx.logger.debug('[%s] %s', scope, message)
    }
  }

  /** Mount one sub-module, converting a throw into a `failed` status. */
  private async mount(id: SubsystemId, run: () => void | Promise<void>): Promise<void> {
    if (!this.isRunning()) return
    this.updateStatus(id, 'starting')
    try {
      await run()
    } catch (error) {
      this.updateStatus(id, 'failed', describeError(error))
      this.diagnostic('warn', id, `subsystem failed to mount: ${describeError(error)}`)
      return
    }
    if (this.statuses[id].state === 'starting') this.updateStatus(id, 'active')
  }
}

/**
 * Cordis entrypoint: start the scheduler and give Cordis its single disposer.
 *
 * The module's `inject` already guarantees the three required services; the
 * explicit probe below keeps a composition change diagnosable instead of letting
 * a missing service surface later as a bare proxy error. When a service is
 * absent the plugin stays `ACTIVE` in restricted mode with every sub-feature
 * disabled rather than failing the fiber.
 */
export function apply(ctx: Context, config?: OrchestratorConfig): void {
  const missing = REQUIRED_SERVICES.filter((service) => ctx.get(service) == null)
  if (missing.length > 0) {
    ctx.logger.warn(
      'required service(s) missing: %s; all sub-features stay disabled',
      missing.join(', '),
    )
    return
  }

  const scheduler = new OrchestratorScheduler(ctx, resolveConfig(config))

  // One effect, one disposer: the scheduler keeps ordered cleanup inside it, so
  // no resource cleanup depends on the relative order sibling effects unload in.
  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.stop()
  }, 'dsh-efficiency-orchestrator:scheduler')
}
