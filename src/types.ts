/**
 * Shared vocabulary of the orchestrator scheduler and its sub-modules.
 *
 * This module intentionally imports nothing from the Host and nothing from the
 * entrypoint: `index.ts` can therefore import the layer modules, while the layers
 * talk back to the scheduler only through {@link SchedulerHost}. That keeps the
 * module graph acyclic and lets the detector stay pure and unit-testable.
 */

/** Sub-features coordinated by the scheduler, in mount order. */
export const SUBSYSTEM_IDS = ['tools', 'streaming', 'execution', 'session'] as const

export type SubsystemId = (typeof SUBSYSTEM_IDS)[number]

/**
 * Lifecycle state of one sub-feature inside the scheduler.
 *
 * `idle` — not mounted yet; `starting` — mounting now; `active` — mounted and
 * running; `disabled` — turned off by plugin config; `unavailable` — yielded to
 * an existing implementation, or a required capability is absent in this
 * profile; `failed` — mounting threw; `stopped` — the scheduler shut it down.
 */
export type SubsystemState =
  | 'idle'
  | 'starting'
  | 'active'
  | 'disabled'
  | 'unavailable'
  | 'failed'
  | 'stopped'

/** Current lifecycle record of one sub-feature. */
export interface SubsystemStatus {
  readonly id: SubsystemId
  state: SubsystemState
  /** Why the sub-feature is not active; set for disabled/unavailable/failed. */
  reason?: string
}

/** Scheduler lifecycle; `idle` sub-features are only meaningful while running. */
export type SchedulerLifecycle = 'created' | 'running' | 'stopping' | 'stopped'

/**
 * Where one visible tool currently comes from.
 *
 * `external-ops` — a mounted OPS provider (for example `dsh-ops/integration`)
 * already publishes it; `self` — this layer registered it; `official` — the
 * Host or another plugin provides it and this layer does not replace it.
 */
export type ToolSource = 'external-ops' | 'self' | 'official'

/** One frozen entry of the tool mapping table. */
export interface ToolMappingEntry {
  /** Whether the tool is visible in the scope this table was frozen from. */
  readonly visible: boolean
  /** Which provider currently owns that visibility. */
  readonly source: ToolSource
}

/** Immutable tool-id → mapping entry table, frozen when the tool layer settles. */
export type ToolMap = ReadonlyMap<string, ToolMappingEntry>

/** Diagnostic severity used by the scheduler log. */
export type DiagnosticLevel = 'debug' | 'info' | 'warn'

/** One structured diagnostic retained in the scheduler's bounded ring. */
export interface OrchestratorDiagnostic {
  readonly at: number
  readonly level: DiagnosticLevel
  readonly scope: string
  readonly message: string
}

/**
 * The slice of the scheduler that sub-modules are allowed to use.
 *
 * Layers never receive the scheduler instance itself, so they cannot reach into
 * its lifecycle or its other sub-features; they can only track owned resources,
 * report their state, publish the frozen tool table, mark truncated reasoning,
 * and write diagnostics.
 */
export interface SchedulerHost {
  /** Queue a plugin-owned cleanup step (drained serially by the scheduler). */
  track(dispose: () => void | Promise<void>): void
  /** Record the lifecycle state of one sub-feature. */
  updateStatus(id: SubsystemId, state: SubsystemState, reason?: string): void
  /** Freeze the tool mapping table; may be called once per scheduler lifetime. */
  installToolMap(entries: Iterable<readonly [string, ToolMappingEntry]>): void
  /** Whether the scheduler is still mounting/running; late async mounts check it. */
  isRunning(): boolean
  /** Whether the tool layer has already frozen the mapping table. */
  hasToolMap(): boolean
  /** The frozen tool mapping table (the execution layer reads it read-only). */
  readonly toolMap: ToolMap
  /** Mark that a reasoning block in this session was truncated in the stream. */
  markReasoningTruncated(sessionId: string): void
  /** Consume the truncated-reasoning mark exactly once before referring to reasoning. */
  consumeReasoningTruncation(sessionId: string): boolean
  /** Record that one compaction finished and a notice is awaiting the next step. */
  markCompactionPending(sessionId: string): void
  /** Whether a compaction notice is pending for this session. */
  hasCompactionPending(sessionId: string): boolean
  /** Consume the pending compaction notice exactly once. */
  consumeCompactionPending(sessionId: string): boolean
  /** Record that this session's budget was exceeded (used by the degraded reminder). */
  noteBudgetExceeded(sessionId: string, detail: string): void
  /** Whether the session's budget was exceeded. */
  isBudgetExceeded(sessionId: string): boolean
  /** Record and log one diagnostic. */
  diagnostic(level: DiagnosticLevel, scope: string, message: string): void
}

/** Small helper so every layer reports failure causes the same way. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
