/**
 * Pure reasoning-loop detector used by the streaming layer.
 *
 * The signal model follows `dsh-no-loop-plugin` (MIT): combine
 *
 * - `ritual` — the same short segment repeated many times in the tail;
 * - `recycle` — a very high rolling-window reuse rate with a very low unique
 *   window ratio (the whole tail is one phrase going round);
 * - `tail` — the last six sentences end with the same phrase.
 *
 * Only those strong signals are used in-stream, because periodicity and
 * character-run rules are known to misfire on code, tables, hashes and long
 * normal prose. The three sensitivity tiers mainly move the thresholds that
 * make "repetition" count, never the structural parameters.
 */
const WINDOW = 16
const RECYCLE_TAIL_CHARS = 8000
const RITUAL_TAIL_CHARS = 900
const RITUAL_SEGMENT_MAX = 14
const TAIL_SEGMENT_MAX = 10
const TAIL_SEGMENT_MIN = 2

/** Detection sensitivity; thresholds per tier are below. */
export type LoopSensitivity = 'loose' | 'normal' | 'strict'

interface LoopTier {
  readonly recycleStrong: number
  readonly uniqueStrong: number
  readonly ritualCount: number
  readonly chatRecycle: number
  readonly chatUnique: number
  readonly chatRitualCount: number
  readonly chatTailCount: number
  readonly tailStrongCount: number
}

/**
 * Tier thresholds. `chat*` variants apply while the accumulated reasoning is
 * shorter than `chatMax` (a chat-sized reply), so a short answer only trips on
 * an extreme shape.
 */
const TIERS: Record<LoopSensitivity, LoopTier> = {
  loose: {
    recycleStrong: 0.90, uniqueStrong: 0.30, ritualCount: 16,
    chatRecycle: 0.95, chatUnique: 0.15, chatRitualCount: 18, chatTailCount: 5, tailStrongCount: 4,
  },
  normal: {
    recycleStrong: 0.85, uniqueStrong: 0.30, ritualCount: 12,
    chatRecycle: 0.92, chatUnique: 0.15, chatRitualCount: 14, chatTailCount: 5, tailStrongCount: 4,
  },
  strict: {
    recycleStrong: 0.78, uniqueStrong: 0.34, ritualCount: 8,
    chatRecycle: 0.88, chatUnique: 0.15, chatRitualCount: 10, chatTailCount: 4, tailStrongCount: 4,
  },
}

/** Tunable stream-detector configuration. */
export interface StreamGuardConfig {
  /** Tier that selects the thresholds. */
  readonly sensitivity: LoopSensitivity
  /** Accrued reasoning characters before the first live probe. */
  readonly minProbe: number
  /** New reasoning characters between live probes. */
  readonly probeStep: number
  /** Tail window handed to a live probe. */
  readonly probeTail: number
  /** Blocks shorter than this are treated as a chat reply. */
  readonly chatMax: number
  /** Accumulated characters before live ritual detection starts. */
  readonly ritualMinChars: number
  /** Characters kept from the head of a truncated reasoning block. */
  readonly keepHead: number
  /** Hard cap on per-stream reasoning text retained for detection. */
  readonly maxChars: number
}

/** Defaults mirror `dsh-no-loop-plugin`'s shipped structural parameters. */
export const DEFAULT_STREAM_GUARD_CONFIG: StreamGuardConfig = Object.freeze({
  sensitivity: 'normal',
  minProbe: 80,
  probeStep: 40,
  probeTail: 4000,
  chatMax: 1200,
  ritualMinChars: 600,
  keepHead: 240,
  maxChars: 200_000,
})

/** Verdict of one detection pass. */
export interface LoopVerdict {
  readonly loop: boolean
  readonly reasons: readonly string[]
  readonly recycle: number
  readonly unique: number
  readonly ritual: number
}

/** Text appended to a truncated block so the next round reads a deliberate stop. */
const YIELD_TEXT = '\n…（推理在此处因复读或循环被截断）'

/** Structural parallelism is legitimate prose, not a loop. */
const PARALLEL = /(不是[^。！？]{0,20}而是|既要[^。！？]{0,20}又要|一边[^。！？]{0,20}一边|有时[^。！？]{0,20}有时|要么[^。！？]{0,20}要么|越来越|一次次|一遍遍)/

function clean(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

function sentences(value: string): string[] {
  return value.split(/(?<=[。！？.!?\n])/)
}

/**
 * Return whether a text is genuine parallel prose.
 *
 * Requires at least three distinct segments and a most-repeated share of at most
 * half, so "A, A, B, A, A" — a word-swapped loop wearing parallelism — is not
 * exempted.
 */
function isParallel(value: string): boolean {
  if (!PARALLEL.test(value)) return false
  const segments = value.split(/[，,；;。！？!?\n]/).map(clean).filter(segment => segment.length > 0)
  if (segments.length < 3) return false
  const frequencies = new Map<string, number>()
  for (const segment of segments) frequencies.set(segment, (frequencies.get(segment) ?? 0) + 1)
  let maxShare = 0
  for (const count of frequencies.values()) maxShare = Math.max(maxShare, count / segments.length)
  return maxShare <= 0.5 && frequencies.size >= 3
}

/** Code, logs, tables and hex naturally repeat; structural rules must skip them. */
function isCodeish(value: string): boolean {
  let score = 0
  if (/=>|\bconst\s+\w+\s*=|\bfunction\s*\w*\s*\(|\bimport\s+.+from\b|\bclass\s+\w+|\bdef\s+\w+\s*\(/.test(value)) score += 2
  if (/(^|\n)\s*[{}();]+\s*(\n|$)/.test(value)) score += 1
  if ((value.match(/(^|\n)[A-Za-z_][\w.\-]{0,40}\s*[=:]\s*\S/g) ?? []).length >= 2) score += 2
  if (/[0-9a-fA-F]{32,}/.test(value)) score += 1
  if ((value.match(/^\s*\|.*\|\s*$/gm) ?? []).length >= 2) score += 1
  if ((value.match(/^\s*(select|insert|update|delete|create|alter|drop)\b/gim) ?? []).length >= 2) score += 2
  return score >= 2
}

/** Last phrase of each of the last six sentences. */
function tailPhrases(value: string): string[] {
  return sentences(value)
    .filter(sentence => sentence.trim().length > 0)
    .slice(-6)
    .map((sentence) => {
      const normalized = clean(sentence)
      return normalized.slice(-Math.min(TAIL_SEGMENT_MAX, normalized.length))
    })
    .filter(phrase => phrase.length >= TAIL_SEGMENT_MIN)
}

/**
 * Rolling-window reuse metrics.
 *
 * @returns `recycle` — share of the most frequent window; `unique` — share of
 * distinct windows. A loop has high recycle and low unique.
 */
function recycleStats(value: string): { recycle: number; unique: number } {
  let normalized = clean(value)
  if (normalized.length > RECYCLE_TAIL_CHARS) normalized = normalized.slice(-RECYCLE_TAIL_CHARS)
  if (normalized.length < WINDOW * 2) return { recycle: 0, unique: 1 }
  const windows: string[] = []
  for (let index = 0; index + WINDOW <= normalized.length; index += WINDOW / 2) {
    windows.push(normalized.slice(index, index + WINDOW))
  }
  const frequencies = new Map<string, number>()
  for (const window of windows) frequencies.set(window, (frequencies.get(window) ?? 0) + 1)
  let maxFrequency = 0
  for (const count of frequencies.values()) maxFrequency = Math.max(maxFrequency, count)
  return { recycle: maxFrequency / windows.length, unique: new Set(windows).size / windows.length }
}

/** Most frequent short segment in the tail (the "ritual" signal). */
function ritualStats(value: string, minCount: number, maxSegment: number): { hit: boolean; count: number; segment: string } {
  const tail = value.slice(-RITUAL_TAIL_CHARS).replace(/```[\s\S]*?```/g, ' ')
  const segments = tail
    .split(/[\n。！？!?；;]+/)
    .map(segment => segment.trim().replace(/\s+/g, ''))
    .filter(segment => segment.length >= 1 && segment.length <= maxSegment)
  const frequencies = new Map<string, number>()
  for (const segment of segments) frequencies.set(segment, (frequencies.get(segment) ?? 0) + 1)
  let segment = ''
  let count = 0
  for (const [candidate, occurrences] of frequencies) {
    if (occurrences > count) {
      segment = candidate
      count = occurrences
    }
  }
  return { hit: count >= minCount, count, segment }
}

/** Whether the last six sentences are copies of each other, or extremely short. */
function tailBodies(value: string): boolean {
  const bodies = sentences(value).filter(sentence => sentence.trim().length > 0).slice(-6).map(clean)
  const unique = new Set(bodies).size
  const average = bodies.length > 0 ? bodies.reduce((sum, body) => sum + body.length, 0) / bodies.length : 0
  return unique <= 3 || average <= 8
}

/**
 * Run one strong-signal detection pass.
 *
 * @param value - reasoning text to inspect (the caller passes a bounded tail for
 * live probes, or the whole block for the final check).
 * @param config - stream detector configuration.
 * @returns the verdict; `loop: false` on any non-hit, never a throw by design.
 */
export function detectStrongLoop(value: string, config: StreamGuardConfig): LoopVerdict {
  // Fall back to the shipped tier if a caller supplies an unknown sensitivity
  // (the type rejects it, but configuration is not always typed at the edge).
  const tier = TIERS[config.sensitivity] ?? TIERS.normal
  const short = value.length < config.chatMax
  const { recycle, unique } = recycleStats(value)
  const ritualMin = short ? tier.chatRitualCount : tier.ritualCount
  const ritual = ritualStats(value, ritualMin, RITUAL_SEGMENT_MAX)
  const recycleHit = recycle >= (short ? tier.chatRecycle : tier.recycleStrong)
    && unique < (short ? tier.chatUnique : tier.uniqueStrong)

  // A true parallel structure is prose, but an extreme recycle rate still wins:
  // "A,B,C,A,B,C" cycles look parallel per-segment while being a loop.
  if (isParallel(value) && !recycleHit) {
    return { loop: false, reasons: [], recycle, unique, ritual: ritual.count }
  }

  const reasons: string[] = []
  if (ritual.hit) reasons.push(`ritual:${ritual.segment}x${ritual.count}`)
  if (recycleHit) reasons.push(`recycle:${recycle.toFixed(2)}`)
  if (!isCodeish(value)) {
    const frequencies = new Map<string, number>()
    for (const phrase of tailPhrases(value)) frequencies.set(phrase, (frequencies.get(phrase) ?? 0) + 1)
    let segment = ''
    let count = 0
    for (const [candidate, occurrences] of frequencies) {
      if (occurrences > count) {
        segment = candidate
        count = occurrences
      }
    }
    const min = short ? tier.chatTailCount : tier.tailStrongCount
    if (count >= min && segment.length >= TAIL_SEGMENT_MIN && tailBodies(value)) {
      reasons.push(`tail:${segment}x${count}`)
    }
  }
  return { loop: reasons.length > 0, reasons, recycle, unique, ritual: ritual.count }
}

/**
 * Build the replacement block text written back to the session log.
 *
 * Keeping the head preserves what the model actually established; the appended
 * sentence makes the next round see a deliberate stop instead of a stream that
 * silently ended mid-thought.
 */
export function truncateReasoning(value: string, keepHead: number): string {
  return value.slice(0, keepHead) + YIELD_TEXT
}
