/**
 * Streaming layer: the `llm/stream` reasoning loop breaker.
 *
 * The layer attaches one synchronous waterfall listener. It only inspects
 * `reasoning-delta` chunks and, when a block trips the detector, it
 *
 * - drops the remaining reasoning deltas of that block, so the UI stops
 *   receiving the runaway text, and
 * - replaces the block's `block-end` payload with the truncated reasoning, so
 *   the version written back into the session log is the truncated one —
 *   persistence, not the UI, decides whether the next round is re-fed the loop.
 *
 * Text deltas and tool-call deltas are forwarded byte-for-byte. Detector
 * failures disable detection for that stream and pass chunks through untouched;
 * a listener that cannot wrap the upstream returns it unchanged. The listener
 * must return the `AsyncIterable` synchronously — returning a Promise here makes
 * the Host reject the stream with "stream is not async iterable".
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  isAsyncIterable,
  isBlockEnd,
  isReasoningDelta,
  isRecord,
  onLlmStream,
  readSessionId,
  type HostGenerateOptions,
} from './host.js'
import {
  DEFAULT_STREAM_GUARD_CONFIG,
  detectStrongLoop,
  truncateReasoning,
  type LoopVerdict,
  type StreamGuardConfig,
} from './reasoning-loop-detector.js'
import { describeError, type SchedulerHost } from './types.js'

/** Per-block detection state of one live model call. */
interface ReasoningSlot {
  /** Detector text accumulated for this block (bounded by `config.maxChars`). */
  text: string
  /** The block already tripped; later deltas are dropped. */
  halted: boolean
  /** Text length at the previous live probe. */
  lastProbeAt: number
  /** Whether the block-end final check already ran. */
  checkedEnd: boolean
}

/**
 * Streaming guard bound to one Host lifetime.
 *
 * The guard never owns timers. It does own per-stream reasoning buffers; they are
 * queued with the scheduler through {@link SchedulerHost.track} so
 * `ResourceManager` clears them during unload, and each generator also clears its
 * own buffer in `finally`.
 */
export class StreamingLayer {
  private readonly ctx: Context
  private readonly scheduler: SchedulerHost
  private readonly config: StreamGuardConfig
  /** Live per-call reasoning buffers, so unload can drop them eagerly. */
  private readonly buffers = new Set<Map<number, ReasoningSlot>>()
  private disposed = false
  private started = false

  constructor(
    ctx: Context,
    scheduler: SchedulerHost,
    config: StreamGuardConfig = DEFAULT_STREAM_GUARD_CONFIG,
  ) {
    this.ctx = ctx
    this.scheduler = scheduler
    this.config = config
  }

  /** Mount the waterfall listener and register the buffer cleanup. */
  start(): void {
    if (this.started) return
    this.started = true

    // The reasoning buffers are plugin-owned memory that Cordis does not track,
    // so they enter the scheduler's serial cleanup queue instead of relying on
    // garbage collection after unload.
    this.scheduler.track(() => { this.releaseBuffers() })

    onLlmStream(this.ctx, (options, next) => this.wrapStream(options, next))
    this.scheduler.updateStatus('streaming', 'active', 'llm/stream guard attached (reasoning-delta only)')
    this.scheduler.diagnostic('debug', 'streaming', 'llm/stream guard mounted (reasoning-delta only)')
  }

  /**
   * Wrap one model call.
   *
   * @param options - model-call options (only `sessionId` is read).
   * @param next - reaches the rest of the waterfall / the adapter stream.
   * @returns the guard iterable, or the upstream unchanged when it is not a
   * stream or cannot be wrapped.
   */
  private wrapStream(options: HostGenerateOptions, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    // Errors thrown by `next()` belong to the upstream chain and propagate as-is.
    const upstream = next()
    if (!isAsyncIterable(upstream)) return upstream
    try {
      return this.guard(upstream, readSessionId(options))
    } catch (error) {
      this.scheduler.diagnostic('warn', 'streaming', `stream guard could not wrap the upstream: ${describeError(error)}`)
      return upstream
    }
  }

  /** Pass chunks through, inspecting only reasoning content. */
  private async *guard(upstream: AsyncIterable<unknown>, sessionId: string): AsyncIterableIterator<unknown> {
    const slots = new Map<number, ReasoningSlot>()
    this.buffers.add(slots)
    let detectionDisabled = false
    try {
      for await (const chunk of upstream) {
        if (this.disposed || !this.scheduler.isRunning() || detectionDisabled || !isRecord(chunk)) {
          yield chunk
          continue
        }

        if (isReasoningDelta(chunk)) {
          const index = chunk.index
          let slot = slots.get(index)
          if (slot === undefined) {
            slot = { text: '', halted: false, lastProbeAt: 0, checkedEnd: false }
            slots.set(index, slot)
          }
          if (slot.halted) continue

          slot.text = capText(slot.text + chunk.text, this.config.maxChars)
          if (slot.text.length >= this.config.minProbe
            && slot.text.length - slot.lastProbeAt >= this.config.probeStep) {
            slot.lastProbeAt = slot.text.length
            // Ritual evidence needs a minimum amount of text; short probes only
            // run past the chat tier by accident and produce false positives.
            if (slot.text.length >= this.config.ritualMinChars) {
              const probe = slot.text.length > this.config.probeTail
                ? slot.text.slice(-this.config.probeTail)
                : slot.text
              const verdict = this.tryDetect(probe)
              if (verdict === null) {
                detectionDisabled = true
              } else if (verdict.loop) {
                slot.halted = true
                this.reportTruncation(sessionId, index, verdict)
              }
            }
          }
          if (slot.halted) continue
          yield chunk
          continue
        }

        if (isBlockEnd(chunk)) {
          const index = chunk.index
          const slot = slots.get(index)
          if (slot !== undefined && chunk.block.type === 'reasoning') {
            // Final check: short repetitions may never reach `minProbe` live.
            if (!slot.halted && !slot.checkedEnd) {
              slot.checkedEnd = true
              const verdict = this.tryDetect(slot.text)
              if (verdict === null) {
                detectionDisabled = true
              } else if (verdict.loop) {
                slot.halted = true
                this.reportTruncation(sessionId, index, verdict)
              }
            }
            if (slot.halted) {
              // The durable block must be the truncated one, not only the live UI.
              const kept = truncateReasoning(slot.text, this.config.keepHead)
              slots.delete(index)
              yield { ...chunk, block: { type: 'reasoning', text: kept } }
              continue
            }
          }
          slots.delete(index)
          yield chunk
          continue
        }

        yield chunk
      }
    } finally {
      slots.clear()
      this.buffers.delete(slots)
    }
  }

  /**
   * Run the detector defensively.
   *
   * @returns the verdict, or `null` when the detector threw; the caller then
   * disables detection for this stream and passes chunks through unchanged.
   */
  private tryDetect(text: string): LoopVerdict | null {
    try {
      return detectStrongLoop(text, this.config)
    } catch (error) {
      this.scheduler.diagnostic(
        'warn',
        'streaming',
        `loop detection failed; detection disabled for this stream: ${describeError(error)}`,
      )
      return null
    }
  }

  /** Record a truncation in the scheduler and in diagnostics. */
  private reportTruncation(sessionId: string, index: number, verdict: LoopVerdict): void {
    this.scheduler.markReasoningTruncated(sessionId)
    this.scheduler.diagnostic(
      'info',
      'streaming',
      `reasoning block ${index} truncated (${verdict.reasons.join(', ')}; `
        + `recycle=${verdict.recycle.toFixed(2)}, unique=${verdict.unique.toFixed(2)})`,
    )
  }

  /** Unload the live reasoning buffers and stop detecting for in-flight streams. */
  private releaseBuffers(): void {
    this.disposed = true
    for (const slots of this.buffers) slots.clear()
    this.buffers.clear()
  }
}

/**
 * Bound the detector text of one block without dropping the tail.
 *
 * A runaway reasoning block can reach hundreds of thousands of characters; the
 * head keeps the beginning of the thought and the tail keeps the loop evidence.
 */
/** Elision marker between the retained head and tail of a reasoning block. */
const SEPARATOR = '\n…\n'

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // Keep the separator inside the budget so the retained text never exceeds
  // `maxChars`, even when a caller configures a cap smaller than the head.
  const head = Math.min(400, Math.max(0, maxChars - SEPARATOR.length))
  const tail = Math.max(0, maxChars - head - SEPARATOR.length)
  return text.slice(0, head) + SEPARATOR + (tail > 0 ? text.slice(text.length - tail) : '')
}
