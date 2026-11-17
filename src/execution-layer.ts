/**
 * Execution layer: batch tool-call suggestions.
 *
 * Two channels, both gated by config and by the absence of a competing
 * `batch-tool-calls:policy` section:
 *
 * 1. A static prompt section (`dsh-efficiency-orchestrator:batch-policy`, order
 *    9550–9599) registered once through `ctx.systemPrompt.section()`. Its text
 *    resolves the visible read-only ids from the live registry at each assembly,
 *    so a preset-composed surface (where `read`/`glob`/`grep` — or their OPS
 *    replacements — live in the Agent scope) names the ids that Agent really has;
 *    the frozen profile table is only the fallback for an agent-less preview.
 * 2. An optional post-compaction notice. `compaction/end` is a Session-log event,
 *    so it arrives through `session/event`; the layer records a pending mark in
 *    the scheduler and the next `agent/pre-step` inserts one short notice (≤ 80
 *    characters). The step hook first consumes the scheduler's truncated-reasoning
 *    mark so nothing it emits can quote truncated reasoning.
 *
 * Both registrations go through Cordis (`ctx.systemPrompt.section`, `ctx.on`), so
 * unload removes them. This layer never registers sections from `agent/pre-step`.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  BATCH_SECTION_NAME,
  UPSTREAM_BATCH_SECTION_NAME,
  type ResolvedOrchestratorConfig,
} from './config.js'
import {
  isRecord,
  onPreStep,
  onSessionEvent,
  systemPromptOf,
  toolsOf,
  type HostAssembleContext,
  type HostPreStepDecision,
  type HostPreStepPayload,
  type HostSystemPrompt,
} from './host.js'
import { buildCompactionNoticeSummary, buildCompactionNoticeText, createNoticeMessage, insertNotice } from './notice.js'
import { OPS_TOOL_PAIRS, visibleReadToolIds } from './tool-layer.js'
import { describeError, type SchedulerHost, type ToolMap } from './types.js'

/** Result of the read-only batch-policy conflict probe. */
type ConflictProbe = 'clear' | 'conflict' | 'unconfirmed'

/** Enter-decision narrowing used by the notice insertion. */
type EnterDecision = Extract<HostPreStepDecision, { kind: 'enter' }>

/**
 * Pick the tool ids the batch section may name from the frozen mapping table.
 *
 * This is the agent-less fallback only: when an assembly carries an Agent, the
 * live registry is queried instead (see {@link ExecutionLayer.batchToolIds}).
 * An OPS id is preferred while it is visible, otherwise its official counterpart
 * is used; hidden or unmounted ids never appear.
 */
function collectBatchToolIds(toolMap: ToolMap, limit: number): string[] {
  if (limit <= 0) return []
  const ids: string[] = []
  for (const pair of OPS_TOOL_PAIRS) {
    const visible = toolMap.get(pair.ops)?.visible === true
      ? pair.ops
      : toolMap.get(pair.official)?.visible === true ? pair.official : undefined
    if (visible !== undefined) ids.push(visible)
  }
  return ids.slice(0, limit)
}

/** Build the static batch-policy section text. */
function buildBatchPolicyText(toolIds: readonly string[]): string {
  const lines = [
    '## 省步数：一步之内批量发起互不依赖的工具调用',
    '',
    '每一步都会重发完整上下文（命中缓存同样计费）。互不依赖的只读调用（读文件、搜索、列举）应在同一步一次发齐，通常 3–6 个。',
  ]
  if (toolIds.length > 0) {
    lines.push(`当前可见的只读工具：${toolIds.map(id => `\`${id}\``).join('、')}。`)
  }
  lines.push(
    '只有下一步需要上一步的结果时才拆步；同一文件的多次修改、依赖链、破坏性操作、需要确认的动作仍逐步执行。',
    '每步自检：准备只发一个工具调用之前，先确认没有可并进来的互不依赖调用。',
  )
  return lines.join('\n')
}

/** Read the durable session id from an agent object, tolerating live shapes. */
function sessionIdOfAgent(agent: HostPreStepPayload['agent']): string | undefined {
  if (!isRecord(agent)) return undefined
  if (typeof agent.id === 'string') return agent.id
  const session = agent.session
  if (isRecord(session) && typeof session.id === 'string') return session.id
  return undefined
}

/** Execution layer bound to one Host lifetime. */
export class ExecutionLayer {
  private readonly ctx: Context
  private readonly scheduler: SchedulerHost
  private readonly config: ResolvedOrchestratorConfig
  private started = false
  private sectionRegistered = false
  private noticeFailureReported = false

  constructor(ctx: Context, scheduler: SchedulerHost, config: ResolvedOrchestratorConfig) {
    this.ctx = ctx
    this.scheduler = scheduler
    this.config = config
  }

  /**
   * Probe → register section → register step/compaction hooks.
   *
   * Runs inside the scheduler startup after the tool layer froze the mapping
   * table; the async conflict probe is the only reason this layer is async.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const execution = this.config.execution

    if (!execution.enabled) {
      this.scheduler.updateStatus('execution', 'disabled', 'execution layer disabled by config')
      return
    }
    if (!this.scheduler.hasToolMap()) {
      this.scheduler.updateStatus('execution', 'unavailable', 'tool mapping table is not frozen')
      this.scheduler.diagnostic('warn', 'execution', 'tool mapping table missing; batch section not registered')
      return
    }
    if (!execution.batch.enabled) {
      this.scheduler.updateStatus('execution', 'disabled', 'batch policy disabled by config (default)')
      this.scheduler.diagnostic('debug', 'execution', 'batch policy disabled by config; section and notice channel stay off')
      return
    }

    const prompt = systemPromptOf(this.ctx)
    if (prompt === undefined) {
      this.scheduler.updateStatus('execution', 'unavailable', 'ctx.systemPrompt is unavailable')
      this.scheduler.diagnostic('warn', 'execution', 'systemPrompt service unavailable; batch section not registered')
      return
    }

    // Read-only conflict probe: never a trial registration.
    const conflict = await this.probeConflict(prompt)
    if (!this.scheduler.isRunning()) return
    if (conflict === 'conflict') {
      this.scheduler.updateStatus('execution', 'unavailable', 'yielded to an existing batch-tool-calls:policy')
      this.scheduler.diagnostic(
        'info',
        'execution',
        `prompt sections already contain "${UPSTREAM_BATCH_SECTION_NAME}"; yielded without registering (notice channel also off)`,
      )
      return
    }
    if (conflict === 'unconfirmed') {
      this.scheduler.updateStatus('execution', 'unavailable', 'cannot confirm no prompt-section conflict')
      this.scheduler.diagnostic(
        'warn',
        'execution',
        'cannot confirm read-only whether a batch-policy section exists; refusing to register a potentially competing section',
      )
      return
    }

    const staticIds = collectBatchToolIds(this.scheduler.toolMap, execution.batch.maxToolHints)
    try {
      prompt.section({
        name: BATCH_SECTION_NAME,
        order: execution.batch.order,
        // Resolve the hinted ids per assembly: a preset-composed surface (Web)
        // registers read/glob/grep inside each Agent scope, so a profile-level
        // snapshot either names the wrong set or — as before this fix — nothing.
        text: (context: HostAssembleContext) => buildBatchPolicyText(this.batchToolIds(context.agent)),
      })
    } catch (error) {
      this.scheduler.updateStatus('execution', 'failed', `section registration failed: ${describeError(error)}`)
      this.scheduler.diagnostic('warn', 'execution', `batch policy section registration failed: ${describeError(error)}`)
      return
    }
    this.sectionRegistered = true

    this.registerStepHook()
    if (execution.notice) {
      this.registerCompactionHook()
    } else {
      this.scheduler.diagnostic('debug', 'execution', 'post-compaction notice disabled by config')
    }

    this.scheduler.updateStatus(
      'execution',
      'active',
      `batch policy registered (order ${execution.batch.order}); notice ${execution.notice ? 'enabled' : 'disabled'}`,
    )
    this.scheduler.diagnostic(
      'info',
      'execution',
      `batch policy section registered (order ${execution.batch.order}, ${staticIds.length} profile-scope tool hint(s)); `
        + `post-compaction notice ${execution.notice ? 'enabled' : 'disabled'}`,
    )
  }

  /**
   * Resolve the read-only ids one assembly may name.
   *
   * The live registry is authoritative because OPS publication may have happened
   * inside this Agent's own scope; the frozen profile table is only the fallback
   * for an agent-less preview, where no Agent scope exists to query.
   *
   * @param agent - Agent of the assembly being rendered, when the Host supplies it.
   * @returns at most `maxToolHints` visible ids.
   */
  private batchToolIds(agent: unknown): string[] {
    const limit = this.config.execution.batch.maxToolHints
    if (limit <= 0) return []
    const tools = toolsOf(this.ctx)
    if (tools !== undefined && isRecord(agent)) {
      // The Agent is the query's explicit viewing scope. `get(name)` without it
      // reads the profile view, where a preset-composed surface registers no
      // read/glob/grep at all.
      try {
        return visibleReadToolIds(tools, agent, limit)
      } catch (error) {
        this.scheduler.diagnostic(
          'debug',
          'execution',
          `per-agent tool lookup failed (${describeError(error)}); using the frozen mapping table`,
        )
      }
    }
    return collectBatchToolIds(this.scheduler.toolMap, limit)
  }

  /**
   * Enumerate prompt sections read-only via `assemble()`.
   *
   * DSH does not expose a stable "list all sections" API; `assemble()` is the
   * only read-only projection. Any failure means the absence of a conflict cannot
   * be confirmed, and the safe default is not registering.
   */
  private async probeConflict(prompt: HostSystemPrompt): Promise<ConflictProbe> {
    if (typeof prompt.assemble !== 'function') return 'unconfirmed'
    try {
      const assembly = await prompt.assemble()
      const names = new Set<string>()
      for (const section of assembly.sections ?? []) names.add(section.name)
      if (names.has(UPSTREAM_BATCH_SECTION_NAME) || names.has(BATCH_SECTION_NAME)) return 'conflict'
      return 'clear'
    } catch (error) {
      this.scheduler.diagnostic(
        'debug',
        'execution',
        `cannot enumerate prompt sections for the conflict check (${describeError(error)})`,
      )
      return 'unconfirmed'
    }
  }

  /**
   * Register the `agent/pre-step` hook.
   *
   * Truncation marks are consumed first (causal order), then — only for an
   * entering step with a pending compaction mark — one notice is inserted.
   */
  private registerStepHook(): void {
    onPreStep(this.ctx, async (payload, next) => {
      // A step can still be in flight while the fiber unloads; do no work once
      // the scheduler has left the running state (marks are already cleared).
      if (!this.scheduler.isRunning()) return next()
      const sessionId = sessionIdOfAgent(payload.agent)
      if (sessionId !== undefined) this.scheduler.consumeReasoningTruncation(sessionId)
      const decision = await next()
      if (!this.sectionRegistered || !this.config.execution.notice) return decision
      if (decision.kind !== 'enter') return decision
      if (payload.signal?.aborted === true) return decision
      if (sessionId === undefined) return decision
      return this.insertCompactionNotice(sessionId, payload, decision)
    })
  }

  /** Insert at most one notice per recorded compaction point. */
  private insertCompactionNotice(
    sessionId: string,
    payload: HostPreStepPayload,
    decision: EnterDecision,
  ): HostPreStepDecision {
    if (!this.scheduler.hasCompactionPending(sessionId)) return decision
    try {
      const notice = createNoticeMessage(buildCompactionNoticeText(), buildCompactionNoticeSummary())
      const messages = insertNotice(decision.messages, payload.messages, notice)
      this.scheduler.consumeCompactionPending(sessionId)
      return { ...decision, messages }
    } catch (error) {
      // Serial "judge → insert → clear" (single synchronous block): a failure
      // clears the mark and is reported once; it is never retried.
      this.scheduler.consumeCompactionPending(sessionId)
      if (!this.noticeFailureReported) {
        this.noticeFailureReported = true
        this.scheduler.diagnostic(
          'warn',
          'execution',
          `post-compaction notice insertion failed and was cleared without retry: ${describeError(error)}`,
        )
      }
      return decision
    }
  }

  /**
   * Observe the durable `compaction/end` log event and record a pending mark.
   *
   * `compaction/end` is not a Host event in this DSH line; it is a session-log
   * event delivered post-commit through `session/event`. When the session event
   * feed is unavailable, the notice channel is skipped with a diagnostic and the
   * section channel keeps working.
   */
  private registerCompactionHook(): void {
    if (this.ctx.get('agents') == null) {
      this.scheduler.diagnostic(
        'info',
        'execution',
        'session/event feed is unavailable (no agents service); post-compaction notice channel skipped',
      )
      return
    }
    onSessionEvent(this.ctx, (session, event) => {
      if (event.type !== 'compaction/end') return
      // A failed compaction also logs its end event with an error; only a
      // successful condensation should re-assert the batching rule.
      if (isRecord(event.data) && event.data.error !== undefined) return
      const sessionId = typeof session.id === 'string' ? session.id : undefined
      if (sessionId === undefined) return
      this.scheduler.markCompactionPending(sessionId)
    })
  }
}
