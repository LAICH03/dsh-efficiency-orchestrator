/**
 * Session layer: session budget reminder + optional hard stop.
 *
 * Contract boundaries this layer keeps:
 *
 * - The budget parameters are **soft-probed** from optional, read-only profile
 *   /preset configuration entries (`settings.describe()`, `configEditor
 *   .configuration()`, `agentPresets.list()`). This plugin never claims to read
 *   any budget from `dsh-flash-presets`; when no explicit turn limit is readable
 *   it falls back to its own step counter, which does nothing until configured.
 * - The budget reminder is a **static** section registered through
 *   `ctx.systemPrompt.section()` with order `9700`. Only its rendered text is
 *   conditional: it reads the step state this layer records during
 *   `agent/pre-step`. `pre-step` never registers a section and never inserts a
 *   notice.
 * - Hard stop depends on `agent/pre-step` supporting the blocking decision
 *   `{ kind: 'reject' }`. That capability is probed once at startup; when the
 *   agent loop is absent (or config disables it), the layer records the overrun
 *   in the scheduler and degrades to a strong reminder in the section instead of
 *   blocking progression.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_SECTION_NAME, SESSION_SECTION_ORDER, type ResolvedOrchestratorConfig } from './config.js'
import {
  isRecord,
  onPreStep,
  systemPromptOf,
  type HostAssembleContext,
} from './host.js'
import { describeError, type SchedulerHost } from './types.js'

/** One session's counter state, keyed by durable session id. */
interface SessionStepState {
  /** Steps (fallback mode) or turns (external mode) consumed so far. */
  used: number
  /** The budget was exceeded at least once. */
  over: boolean
}

/** Budget source selected at startup. */
interface SessionBudget {
  /** `external-turn` — an explicit profile/preset turn cap; `fallback-step` — self counter. */
  readonly mode: 'external-turn' | 'fallback-step'
  readonly limit: number
  /** Human-readable origin recorded in diagnostics. */
  readonly source: string
}

/** Result of the early hard-stop capability probe. */
interface HardStopProbe {
  readonly supported: boolean
  readonly detail: string
}

/** One read-only candidate configuration snapshot. */
interface ExternalCandidate {
  readonly source: string
  readonly value: unknown
}

/** Bounded session map: a long-lived Host must not accumulate state forever. */
const MAX_TRACKED_SESSIONS = 128

/** Keys that can carry an explicit turn/round cap in profile or preset config. */
const TURN_LIMIT_KEYS = ['turnLimit', 'maxTurns', 'maxUserTurns', 'maxRounds', 'roundLimit'] as const

/**
 * Probe the `agent/pre-step` blocking capability during apply.
 *
 * The decision contract (`{ kind: 'reject' }`) belongs to the agent loop; when no
 * agent loop service is mounted, a reject can never be delivered and the layer
 * must not pretend to be able to stop.
 */
function probeHardStop(ctx: Context): HardStopProbe {
  if (typeof ctx.on !== 'function') return { supported: false, detail: 'event bus unavailable' }
  const agentLoop = ctx.get('agentLoop')
  if (agentLoop === undefined || agentLoop === null) {
    return { supported: false, detail: 'agent loop service unavailable' }
  }
  return {
    supported: true,
    detail: 'agent/pre-step accepts PreStepDecision; {kind:"reject"} blocks the proposed step',
  }
}

/** Read the durable session id of an assembly context. */
function sessionIdOfAssembly(context: HostAssembleContext): string | undefined {
  const agent = context.agent
  if (isRecord(agent) && typeof agent.id === 'string') return agent.id
  const scope = context.scope
  if (isRecord(scope) && typeof scope.id === 'string') return scope.id
  return undefined
}

/**
 * Recursively scan a configuration value for one explicit turn cap.
 *
 * Only positive safe integers under documented key names count; a nested scan is
 * bounded in depth and array width so a large preset cannot stall startup.
 */
function scanTurnLimit(
  value: unknown,
  source: string,
  path: readonly string[] = [],
  depth = 0,
): { limit: number; source: string } | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    const width = Math.min(value.length, 20)
    for (let index = 0; index < width; index += 1) {
      const found = scanTurnLimit(value[index], source, [...path, String(index)], depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of TURN_LIMIT_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) {
      return { limit: candidate, source: `${source}:${[...path, key].join('.')}` }
    }
  }
  for (const [key, nested] of boundedEntries(record)) {
    const found = scanTurnLimit(nested, source, [...path, key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Object entries capped so a pathological config object cannot stall startup. */
function boundedEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(record)
  return entries.length <= 100 ? entries : entries.slice(0, 100)
}

/** Name one preset candidate for diagnostics. */
function presetName(preset: unknown): string {
  if (isRecord(preset)) {
    if (typeof preset.id === 'string') return preset.id
    if (typeof preset.name === 'string') return preset.name
  }
  return '?'
}

/**
 * Soft-probe explicit turn limits from optional, read-only configuration entries.
 *
 * Every probe is guarded: a missing service, a throwing accessor, or an
 * asynchronous list failure only removes that candidate. Reading these services
 * is a query; nothing is mutated.
 */
async function probeExternalTurnLimit(ctx: Context): Promise<{ limit: number; source: string } | undefined> {
  const candidates: ExternalCandidate[] = []

  const settings = ctx.get('settings')
  if (settings !== undefined && settings !== null && typeof settings.describe === 'function') {
    try {
      const descriptors: unknown = settings.describe()
      if (Array.isArray(descriptors)) {
        for (const descriptor of descriptors) {
          if (!isRecord(descriptor)) continue
          candidates.push({ source: `settings:${String(descriptor.ns ?? '?')}`, value: descriptor.value })
        }
      }
    } catch {
      // Unreadable settings must not break startup.
    }
  }

  const configEditor = ctx.get('configEditor')
  if (configEditor !== undefined && configEditor !== null && typeof configEditor.configuration === 'function') {
    try {
      const entries: unknown = configEditor.configuration()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!isRecord(entry)) continue
          const name = isRecord(entry.entry) && typeof entry.entry.id === 'string' ? entry.entry.id : '?'
          candidates.push({ source: `config:${name}`, value: entry.override ?? entry.inherited })
        }
      }
    } catch {
      // Unreadable configuration must not break startup.
    }
  }

  const agentPresets = ctx.get('agentPresets')
  if (agentPresets !== undefined && agentPresets !== null && typeof agentPresets.list === 'function') {
    try {
      const presets: unknown = await agentPresets.list()
      if (Array.isArray(presets)) {
        for (const preset of presets) candidates.push({ source: `preset:${presetName(preset)}`, value: preset })
      }
    } catch {
      // An unreadable preset registry falls back to the self counter.
    }
  }

  for (const candidate of candidates) {
    try {
      const found = scanTurnLimit(candidate.value, candidate.source)
      if (found !== undefined) return found
    } catch {
      // A hostile or exotic config value must not break plugin startup; try the
      // next candidate instead.
    }
  }
  return undefined
}

/** Session budget layer bound to one Host lifetime. */
export class SessionLayer {
  private readonly ctx: Context
  private readonly scheduler: SchedulerHost
  private readonly config: ResolvedOrchestratorConfig
  private readonly states = new Map<string, SessionStepState>()
  private budget: SessionBudget | undefined
  private hardStopProbe: HardStopProbe = { supported: false, detail: 'not probed' }
  private started = false
  private degradedReported = false

  constructor(ctx: Context, scheduler: SchedulerHost, config: ResolvedOrchestratorConfig) {
    this.ctx = ctx
    this.scheduler = scheduler
    this.config = config
  }

  /** Probe capabilities/budget parameters, register the static section, count steps. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const session = this.config.session

    if (!session.enabled) {
      this.scheduler.updateStatus('session', 'disabled', 'session layer disabled by config')
      return
    }

    // Plugin-owned counter state: cleared through the scheduler's serial cleanup
    // queue so an unload leaves no per-session buffer behind (the instance is
    // also discarded, but the queue makes teardown explicit and ordered).
    this.scheduler.track(() => { this.states.clear() })

    // Early capability probe (apply time): can a step actually be rejected?
    this.hardStopProbe = probeHardStop(this.ctx)
    if (!this.hardStopProbe.supported) {
      this.scheduler.diagnostic(
        'info',
        'session',
        `hard stop unavailable (${this.hardStopProbe.detail}); exceeded budgets degrade to a strong section reminder`,
      )
    }

    // Soft probe of explicit external parameters; never required for startup.
    const external = await probeExternalTurnLimit(this.ctx)
    if (!this.scheduler.isRunning()) return

    const fallbackLimit = session.fallbackStepLimit
    if (external !== undefined) {
      this.budget = { mode: 'external-turn', limit: external.limit, source: external.source }
      this.scheduler.diagnostic(
        'info',
        'session',
        `external turn limit ${external.limit} read from ${external.source}`,
      )
    } else if (fallbackLimit > 0) {
      this.budget = { mode: 'fallback-step', limit: fallbackLimit, source: 'self-built step counter' }
      this.scheduler.diagnostic(
        'info',
        'session',
        `no readable external turn limit; using the self-built step counter with limit ${fallbackLimit}`,
      )
    } else {
      this.scheduler.diagnostic(
        'debug',
        'session',
        'no readable external turn limit and fallbackStepLimit is 0; budget reminders stay inactive',
      )
    }

    const prompt = systemPromptOf(this.ctx)
    if (prompt === undefined) {
      this.scheduler.updateStatus('session', 'unavailable', 'ctx.systemPrompt is unavailable')
      this.scheduler.diagnostic('warn', 'session', 'systemPrompt service unavailable; session budget section not registered')
      return
    }

    // Static registration; only the rendered text depends on counter state.
    try {
      prompt.section({
        name: SESSION_SECTION_NAME,
        order: SESSION_SECTION_ORDER,
        text: context => this.renderSection(context),
      })
    } catch (error) {
      this.scheduler.updateStatus('session', 'failed', `section registration failed: ${describeError(error)}`)
      this.scheduler.diagnostic('warn', 'session', `session budget section registration failed: ${describeError(error)}`)
      return
    }

    if (this.budget !== undefined) this.registerStepCounter()

    const mode = this.budget === undefined
      ? 'inactive (no limit)'
      : `${this.budget.mode} limit ${this.budget.limit} (${this.budget.source})`
    const stop = this.config.session.hardStop && this.hardStopProbe.supported ? 'enabled' : 'reminder-only'
    this.scheduler.updateStatus('session', 'active', `${mode}; hard stop ${stop}`)
    this.scheduler.diagnostic('info', 'session', `session budget section registered (order ${SESSION_SECTION_ORDER}); ${mode}; hard stop ${stop}`)
  }

  /** Update the counter state at step entry. Never registers a section here. */
  private registerStepCounter(): void {
    onPreStep(this.ctx, async (payload, next) => {
      // A step can still be in flight while the fiber unloads; do no work once
      // the scheduler has left the running state (counter state is cleared).
      if (!this.scheduler.isRunning()) return next()
      const budget = this.budget
      if (budget === undefined) return next()
      const agent = payload.agent
      const sessionId = !isRecord(agent)
        ? undefined
        : typeof agent.id === 'string'
          ? agent.id
          : isRecord(agent.session) && typeof agent.session.id === 'string'
            ? agent.session.id
            : undefined
      if (sessionId === undefined) return next()

      const state = this.stateOf(sessionId)
      if (budget.mode === 'external-turn' && Number.isSafeInteger(payload.turn)) {
        state.used = Math.max(state.used, payload.turn)
      } else {
        state.used += 1
      }

      const remaining = budget.limit - state.used
      const wasOver = state.over
      state.over = remaining < 0
      if (state.over) {
        if (!wasOver) {
          // Durable scheduler state: the degraded reminder (and diagnostics)
          // must be able to see that this session exceeded its budget.
          this.scheduler.noteBudgetExceeded(sessionId, `used ${state.used} of ${budget.limit} (${budget.source})`)
        }
        const canStop = this.hardStopProbe.supported && this.config.session.hardStop
        if (canStop) {
          this.scheduler.diagnostic(
            'warn',
            'session',
            `session budget exceeded (used ${state.used} of ${budget.limit}); rejecting the proposed step`,
          )
          return { kind: 'reject' }
        }
        if (!this.hardStopProbe.supported && !this.degradedReported) {
          this.degradedReported = true
          this.scheduler.diagnostic(
            'info',
            'session',
            'budget exceeded while hard stop is unavailable; degraded to a strong section reminder and recorded in scheduler state',
          )
        }
      }
      return next()
    })
  }

  /** Render the conditional budget text for one prompt assembly. */
  private renderSection(context: HostAssembleContext): string {
    const budget = this.budget
    if (budget === undefined) return ''
    const sessionId = sessionIdOfAssembly(context)
    if (sessionId === undefined) return ''
    const state = this.states.get(sessionId)
    if (state === undefined) return ''

    const unit = budget.mode === 'external-turn' ? '轮数' : '步数'
    const remaining = budget.limit - state.used
    if (state.over) {
      // A rejected step assembles no prompt, so this text is a safety net: it is
      // what the model sees if the host does not actually honor the reject (or
      // if hard stop is disabled). Never hide the overrun reminder on a probe
      // result alone.
      return `【预算超限】本会话已超出${unit}预算（已用 ${state.used}/${budget.limit}）。`
        + '请立即停止扩展，直接给出当前最佳结果与未完成事项说明。'
    }
    if (remaining <= this.config.session.warnWithin) {
      return `【预算提醒】本会话接近${unit}预算上限（已用 ${state.used}/${budget.limit}），`
        + '请优先收尾并给出最终结果，避免继续发散。'
    }
    return ''
  }

  /** Read or create the bounded counter state of one session. */
  private stateOf(sessionId: string): SessionStepState {
    const existing = this.states.get(sessionId)
    if (existing !== undefined) return existing
    if (this.states.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.states.keys().next()
      if (!oldest.done) this.states.delete(oldest.value)
    }
    const created: SessionStepState = { used: 0, over: false }
    this.states.set(sessionId, created)
    return created
  }
}
