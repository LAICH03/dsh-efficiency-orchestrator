/**
 * Local structural mirrors of the small Host surface this plugin consumes.
 *
 * The shapes below are copied from the DSH 0.2.2-rc.2 contracts
 * (`@deepseek-ai/dsh-tools` `ToolDefinition`/`ToolsService` and
 * `@deepseek-ai/dsh-llm` `StreamChunk`/`llm-stream`). They are declared locally
 * instead of imported so the package never pulls the Host package graph into its
 * own dependency resolution (the only Host import here is the `@deepseek-ai/cordis`
 * `Context` type, which is erased at runtime). At runtime every object described
 * here is still the Host's own: the accessors only name it, they never mirror its
 * data.
 *
 * If a future DSH release changes one of these signatures, the compiler will
 * point at the single accessor that needs updating.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Content block of a tool result or rendered output. */
export interface HostContentBlock {
  type: string
  [key: string]: unknown
}

/** Canonical output contract of one tool (see `ToolOutputDefinition`). */
export interface HostToolOutputDefinition {
  /** Raw supported JSON Schema enforced against the canonical value. */
  readonly schema: Record<string, unknown>
  /** Pure projection from validated arguments and value to model content. */
  render(args: unknown, value: unknown): HostContentBlock[]
  /** Optional replayable presentation projection. */
  presentationMeta?(args: unknown, value: unknown): unknown
}

/** Completed outcome handed to `presentResult`. */
export interface HostToolResult {
  content: HostContentBlock[]
  isError: boolean
  meta?: unknown
}

/** Pending-call render intent (opaque to this plugin; forwarded untouched). */
export interface HostToolCallView {
  card: string
  [key: string]: unknown
}

/** Completed-call render intent (opaque to this plugin; forwarded untouched). */
export interface HostToolResultView {
  card: string
  [key: string]: unknown
}

/**
 * Execution context handed to a tool body.
 *
 * Only `signal` and the identity fields are used here; the OPS tools forward the
 * complete object to the official implementation they delegate to.
 */
export interface HostToolRunContext {
  readonly callId?: unknown
  readonly name: string
  readonly agent?: unknown
  readonly signal: AbortSignal
  readonly [key: string]: unknown
}

/** One registered tool definition (see `ToolDefinition`). */
export interface HostToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  deferLoading?: true
  readonly output: HostToolOutputDefinition
  execute(args: unknown, exec: HostToolRunContext): Promise<unknown>
  projectContent?(exec: unknown, result: unknown): HostContentBlock[] | undefined
  finalizeContent?(exec: unknown, result: unknown): HostContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): HostToolCallView | undefined
  presentResult?(args: unknown, result: HostToolResult): HostToolResultView | undefined
}

/** Per-scope mask over global tools (see `ToolRestriction`). */
export interface HostToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** Step-time activation condition of a registration (see `ToolRegistrationOptions`). */
export interface HostToolRegistrationOptions {
  readonly when?: (context: unknown) => boolean | Promise<boolean>
}

/**
 * Read-only plus registration slice of `ctx.tools` (DSH 0.2.2-rc.2 contracts).
 *
 * The two query methods take the viewing scope as an EXPLICIT argument; they do
 * NOT derive one from the context they are reached through. Only `register()` and
 * `restrict()` bind their scope through `this.ctx` (the traceable service
 * receiver). `agentCtx.tools.get('read')` therefore reads the profile/global
 * view, while `agentCtx.tools.get('read', agent)` reads that Agent's view — the
 * only supported way to ask "does this Agent see it?". Dropping the argument
 * silently reproduces the "official tool is not visible" failure this plugin
 * exists to fix, and it also makes a scoped registration invisible to its own
 * verification query.
 *
 * The query methods are optional on purpose: an older Host may not expose a
 * read-only interface, and the plugin must degrade instead of probing with a
 * throwaway registration.
 */
export interface HostTools {
  get?(name: string, scope?: object): HostToolDefinition | undefined
  definitions?(scope?: object): readonly HostToolDefinition[]
  register(definition: HostToolDefinition, options?: HostToolRegistrationOptions): () => void
  restrict(filter: HostToolRestriction): () => void
}

/**
 * Resolve one tool definition as a scope sees it, without changing anything.
 *
 * `get(name, scope)` is the precise Host query (a restricted-away name reads as
 * absent); `definitions(scope)` is the enumeration fallback for a Host that
 * exposes no point lookup. The scope argument is load-bearing, not decorative:
 * omitting it queries the profile view and reports a preset-scoped Agent's tools
 * as absent. A throwing query is treated as "not visible" so a probe can never
 * break the caller's lifecycle path.
 *
 * @param tools - the `ctx.tools` registry handle.
 * @param name - tool id to resolve.
 * @param scope - viewing scope (the Agent), or `undefined` for the profile view.
 * @returns the definition that scope resolves, or `undefined`.
 */
export function visibleToolOf(
  tools: HostTools,
  name: string,
  scope?: object,
): HostToolDefinition | undefined {
  if (typeof tools.get === 'function') {
    try {
      return tools.get(name, scope)
    } catch {
      return undefined
    }
  }
  if (typeof tools.definitions === 'function') {
    try {
      const definitions = scope === undefined ? tools.definitions() : tools.definitions(scope)
      for (const definition of definitions) {
        if (definition.name === name) return definition
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Read `ctx.tools` without assuming the service is mounted. */
export function toolsOf(ctx: Context): HostTools | undefined {
  const tools = (ctx as unknown as { tools?: HostTools }).tools
  if (tools === undefined || typeof tools.register !== 'function') return undefined
  return tools
}

/** Request options of an `llm/stream` call (only `sessionId` is consumed here). */
export interface HostGenerateOptions {
  readonly sessionId?: unknown
  readonly [key: string]: unknown
}

/** Stream chunk after a `reasoning-delta` type guard. */
export interface HostReasoningDelta {
  type: 'reasoning-delta'
  index: number
  text: string
}

/** Stream chunk after a `block-end` type guard. */
export interface HostBlockEnd {
  type: 'block-end'
  index: number
  block: { type: string; text?: string }
}

/** Synchronous waterfall listener for `llm/stream` (must return an AsyncIterable). */
export type HostLlmStreamListener = (
  options: HostGenerateOptions,
  next: () => AsyncIterable<unknown>,
) => AsyncIterable<unknown>

/**
 * Register an `llm/stream` waterfall listener.
 *
 * The Host event is a waterfall whose last argument is `next`; the listener has
 * to return an `AsyncIterable` synchronously (returning a Promise here makes the
 * Host reject the stream with "stream is not async iterable"). The local event
 * type keeps listeners honest about that shape.
 */
export function onLlmStream(ctx: Context, listener: HostLlmStreamListener): () => void {
  const on = ctx.on as unknown as (
    name: 'llm/stream',
    listener: HostLlmStreamListener,
  ) => () => boolean
  const dispose = on('llm/stream', listener)
  return () => { dispose() }
}

/** Read the durable session id of one model call, when the Host provides one. */
export function readSessionId(options: HostGenerateOptions | undefined): string {
  if (options === undefined) return ''
  const value = options.sessionId
  return typeof value === 'string' ? value : ''
}

/** Narrow an unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Type guard for a stream `reasoning-delta` chunk. */
export function isReasoningDelta(chunk: unknown): chunk is HostReasoningDelta {
  return isRecord(chunk)
    && chunk.type === 'reasoning-delta'
    && typeof chunk.index === 'number'
    && typeof chunk.text === 'string'
}

/** Type guard for a stream `block-end` chunk. */
export function isBlockEnd(chunk: unknown): chunk is HostBlockEnd {
  return isRecord(chunk)
    && chunk.type === 'block-end'
    && typeof chunk.index === 'number'
    && isRecord(chunk.block)
    && typeof chunk.block.type === 'string'
}

/** Type guard for an async iterable stream. */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value)
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/** Context handed to a prompt section's dynamic text provider. */
export interface HostAssembleContext {
  /** Agent the assembly is for (`assembleContextFor()` sets it together with `scope`). */
  readonly agent?: unknown
  /** Scope key of the assembly; in the Host this is the same Agent object. */
  readonly scope?: unknown
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

/** One prompt section registration (see `PromptSection`). */
export interface HostPromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: HostAssembleContext) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}

/** Assembled prompt presentation (only `sections` is read here). */
export interface HostPromptAssembly {
  readonly sections?: ReadonlyArray<{ readonly name: string; readonly text: string }>
  readonly [key: string]: unknown
}

/** Read/registration slice of `ctx.systemPrompt`. */
export interface HostSystemPrompt {
  section(section: HostPromptSection): () => void
  /** Read-only assembly used to enumerate section names without registering. */
  assemble?(context?: HostAssembleContext): Promise<HostPromptAssembly>
}

/** Read `ctx.systemPrompt` without assuming the service is mounted. */
export function systemPromptOf(ctx: Context): HostSystemPrompt | undefined {
  const systemPrompt = (ctx as unknown as { systemPrompt?: HostSystemPrompt }).systemPrompt
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return undefined
  return systemPrompt
}

/** A user message as it enters a step (durable shape, local mirror). */
export interface HostUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly [key: string]: unknown }>
  readonly source: { readonly kind: string; readonly [key: string]: unknown }
  readonly [key: string]: unknown
}

/** Payload of `agent/pre-step`. */
export interface HostPreStepPayload {
  readonly agent: { readonly id?: unknown; readonly [key: string]: unknown }
  readonly messages: readonly HostUserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal?: AbortSignal
}

/** Decision returned by the `agent/pre-step` waterfall. */
export type HostPreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: HostUserMessage[]; readonly startsRequestSeries?: true }

/** Synchronous-registration waterfall listener for `agent/pre-step`. */
export type HostPreStepListener = (
  payload: HostPreStepPayload,
  next: () => Promise<HostPreStepDecision>,
) => Promise<HostPreStepDecision>

/**
 * Register an `agent/pre-step` waterfall listener.
 *
 * `{ kind: 'reject' }` is the Host's blocking decision for a proposed step; it is
 * how the session layer implements a hard stop, and it is also the capability
 * this plugin probes for before relying on it.
 */
export function onPreStep(ctx: Context, listener: HostPreStepListener): () => void {
  const on = ctx.on as unknown as (
    name: 'agent/pre-step',
    listener: HostPreStepListener,
  ) => () => boolean
  const dispose = on('agent/pre-step', listener)
  return () => { dispose() }
}

/** The session object as seen by `session/event` listeners. */
export interface HostSessionRef {
  readonly id?: unknown
  readonly [key: string]: unknown
}

/** Durable session log event envelope (only `type` and `data` are read here). */
export interface HostSessionEvent {
  readonly type: string
  readonly data?: unknown
  readonly [key: string]: unknown
}

/** Listener of the post-commit `session/event` feed. */
export type HostSessionEventListener = (session: HostSessionRef, event: HostSessionEvent) => void

/**
 * Register a `session/event` listener.
 *
 * `compaction/end` is a Session-log event (log-only), not a Host event: this feed
 * is how the reference batch plugin observes it, and how this plugin records a
 * post-compaction notice mark.
 */
export function onSessionEvent(ctx: Context, listener: HostSessionEventListener): () => void {
  const on = ctx.on as unknown as (
    name: 'session/event',
    listener: HostSessionEventListener,
  ) => () => boolean
  const dispose = on('session/event', listener)
  return () => { dispose() }
}

/** One live Agent as exposed to plugin code; the public interface is minimal. */
export interface HostAgentRef {
  readonly id?: unknown
  /** Agent-scoped Cordis context; present on the concrete loop Agent. */
  readonly ctx?: unknown
  /** Durable session handle exposed by the concrete loop Agent. */
  readonly session?: { readonly id?: unknown; readonly [key: string]: unknown }
  readonly [key: string]: unknown
}

/** Payload of the serial `agent/created` lifecycle event. */
export interface HostAgentCreatedPayload {
  readonly agent: HostAgentRef
  readonly source?: unknown
  readonly signal?: AbortSignal
  readonly [key: string]: unknown
}

/** Payload of the `agent/disposed` lifecycle event. */
export interface HostAgentDisposedPayload {
  readonly agent: HostAgentRef
  readonly [key: string]: unknown
}

/** Read-only slice of the Agent registry service (`ctx.get('agents')`). */
export interface HostAgentsService {
  list?(): readonly HostAgentRef[]
  get?(id: unknown): HostAgentRef | undefined
}

/** Listener of the serial `agent/created` lifecycle event. */
export type HostAgentCreatedListener = (payload: HostAgentCreatedPayload) => void

/** Listener of the `agent/disposed` lifecycle event. */
export type HostAgentDisposedListener = (payload: HostAgentDisposedPayload) => void

/** Probe the optional Agent registry without injecting it. */
export function agentsOf(ctx: Context): HostAgentsService | undefined {
  const agents = ctx.get('agents')
  if (!isRecord(agents)) return undefined
  if (typeof agents.list !== 'function' && typeof agents.get !== 'function') return undefined
  return agents as unknown as HostAgentsService
}

/**
 * Resolve the tools registry through one Agent's scoped context.
 *
 * A service method reached through an Agent context keeps that context as its
 * call receiver (Cordis traceable service), so `restrict()` invoked through this
 * handle creates a scoped restriction owned by the Agent's scope — the supported
 * way to hide global tools from one specific Agent.
 */
export function scopedToolsOf(agentCtx: unknown): HostTools | undefined {
  if (!isRecord(agentCtx)) return undefined
  const tools = (agentCtx as { readonly tools?: HostTools }).tools
  if (tools === undefined || typeof tools.restrict !== 'function') return undefined
  return tools
}

/** Register an `agent/created` lifecycle listener. */
export function onAgentCreated(ctx: Context, listener: HostAgentCreatedListener): () => void {
  const on = ctx.on as unknown as (
    name: 'agent/created',
    listener: HostAgentCreatedListener,
  ) => () => boolean
  const dispose = on('agent/created', listener)
  return () => { dispose() }
}

/** Register an `agent/disposed` lifecycle listener. */
export function onAgentDisposed(ctx: Context, listener: HostAgentDisposedListener): () => void {
  const on = ctx.on as unknown as (
    name: 'agent/disposed',
    listener: HostAgentDisposedListener,
  ) => () => boolean
  const dispose = on('agent/disposed', listener)
  return () => { dispose() }
}
