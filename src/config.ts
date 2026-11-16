/**
 * Configuration for the execution and session layers.
 *
 * The package deliberately has no `Config` schema dependency: the Loader passes
 * the bundle row's `config` mapping through untouched when the plugin exports no
 * schema, so this module normalizes the raw value itself. Defaults follow the
 * documented contracts:
 *
 * - the batch policy section is **not** registered unless explicitly enabled;
 * - the compaction notice follows the batch section (it never fires on its own);
 * - the session budget section is registered by its own switch, but the
 *   self-built fallback counter does **not** trigger anything until configured.
 */

/** One sub-feature's on/off switch. */
export interface FeatureToggle {
  readonly enabled?: boolean
}

/** Batch policy switches and placement. */
export interface BatchPolicyConfig {
  /** Register `dsh-efficiency-orchestrator:batch-policy`. Defaults to false. */
  readonly enabled?: boolean
  /** Section order inside `9550–9599`; defaults to 9550. */
  readonly order?: number
  /** How many visible tool ids the section may name; defaults to 4. */
  readonly maxToolHints?: number
}

/** Execution layer switches. */
export interface ExecutionConfig {
  /** Mount the execution layer at all; defaults to true. */
  readonly enabled?: boolean
  /** Batch suggestion switches; disabled by default. */
  readonly batch?: BatchPolicyConfig
  /** Post-compaction notice; defaults to true and requires the batch section. */
  readonly notice?: boolean
}

/** Session budget switches. */
export interface SessionConfig {
  /** Mount the session budget layer; defaults to true. */
  readonly enabled?: boolean
  /** Reject a step once its budget is exceeded when the Host supports it; defaults to false. */
  readonly hardStop?: boolean
  /**
   * Self-built step counter limit used when no profile/preset turn limit is
   * readable. `0` (default) means the fallback counter never triggers.
   */
  readonly fallbackStepLimit?: number
  /** Steps remaining when the section starts rendering a reminder; defaults to 2. */
  readonly warnWithin?: number
}

/** Raw plugin config accepted from the bundle row. */
export interface OrchestratorConfig {
  /** Tool layer switch; defaults to true. */
  readonly toolLayer?: FeatureToggle
  /** Streaming guard switch; defaults to true. */
  readonly streaming?: FeatureToggle
  readonly execution?: ExecutionConfig
  readonly session?: SessionConfig
}

/** Normalized config consumed by the scheduler and its layers. */
export interface ResolvedOrchestratorConfig {
  readonly toolLayer: { readonly enabled: boolean }
  readonly streaming: { readonly enabled: boolean }
  readonly execution: {
    readonly enabled: boolean
    readonly batch: { readonly enabled: boolean; readonly order: number; readonly maxToolHints: number }
    readonly notice: boolean
  }
  readonly session: {
    readonly enabled: boolean
    readonly hardStop: boolean
    readonly fallbackStepLimit: number
    readonly warnWithin: number
  }
}

/** Section name reserved by this plugin for the batch policy. */
export const BATCH_SECTION_NAME = 'dsh-efficiency-orchestrator:batch-policy'

/** Upstream section name this plugin must yield to. */
export const UPSTREAM_BATCH_SECTION_NAME = 'batch-tool-calls:policy'

/** Allowed batch section order range (exclusive namespace below 9500). */
export const BATCH_ORDER_MIN = 9550
export const BATCH_ORDER_MAX = 9599
/** Default batch section order. */
export const BATCH_ORDER_DEFAULT = 9550

/** Session budget section name and fixed order inside `9700–9799`. */
export const SESSION_SECTION_NAME = 'dsh-efficiency-orchestrator:session-budget'
export const SESSION_SECTION_ORDER = 9700

/** Batch section tool-id hint default. */
const MAX_TOOL_HINTS_DEFAULT = 4
/** Default steps-remaining threshold for the session reminder. */
const WARN_WITHIN_DEFAULT = 2

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * Normalize the raw bundle-row config.
 *
 * Unknown keys are ignored, invalid values fall back to defaults, and numeric
 * ranges are clamped so a bad row can never move a section outside its reserved
 * order range.
 */
export function resolveConfig(raw: unknown): ResolvedOrchestratorConfig {
  const root = asRecord(raw) ?? {}
  const toolLayer = asRecord(root.toolLayer) ?? {}
  const streaming = asRecord(root.streaming) ?? {}
  const execution = asRecord(root.execution) ?? {}
  const batch = asRecord(execution.batch) ?? {}
  const session = asRecord(root.session) ?? {}
  return {
    toolLayer: { enabled: readBoolean(toolLayer.enabled, true) },
    streaming: { enabled: readBoolean(streaming.enabled, true) },
    execution: {
      enabled: readBoolean(execution.enabled, true),
      batch: {
        // Contract: registering the section is opt-in, never the default.
        enabled: readBoolean(batch.enabled, false),
        order: readInteger(batch.order, BATCH_ORDER_DEFAULT, BATCH_ORDER_MIN, BATCH_ORDER_MAX),
        maxToolHints: readInteger(batch.maxToolHints, MAX_TOOL_HINTS_DEFAULT, 0, 12),
      },
      notice: readBoolean(execution.notice, true),
    },
    session: {
      enabled: readBoolean(session.enabled, true),
      hardStop: readBoolean(session.hardStop, false),
      fallbackStepLimit: readInteger(session.fallbackStepLimit, 0, 0, 100_000),
      warnWithin: readInteger(session.warnWithin, WARN_WITHIN_DEFAULT, 0, 100),
    },
  }
}
