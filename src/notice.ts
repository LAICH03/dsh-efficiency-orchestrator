/**
 * Durable post-compaction notice message.
 *
 * The notice is a conversation-level user-role message inserted into the step's
 * admitted messages by the `agent/pre-step` waterfall. The Host does not export
 * `createUserMessage` to plugins, so this module mirrors the documented message
 * shape (identity + role + content + producer source) and freezes it before
 * publication — the same approach the reference batch plugin uses.
 *
 * The source uses this plugin's own producer kind (the source union is
 * merge-extensible and unknown kinds are rendered as opaque context) with
 * `form: 'notice'` and a one-line summary, so the injected reminder is not
 * presented as a message the human typed.
 */
import { randomUUID } from 'node:crypto'
import type { HostUserMessage } from './host.js'

/** Producer kind declared in the message source. */
export const NOTICE_SOURCE_KIND = 'dsh-efficiency-orchestrator'

/** Hard limit for the one-line notice text: about one line, no rule restating. */
export const NOTICE_MAX_CHARS = 80

/** The single reminder line inserted after a compaction. */
const COMPACTION_NOTICE_TEXT = '上下文刚压缩：本步把互不依赖的只读工具调用一次发齐，减少步数。'
/** One-line summary rendered by the conversation UI. */
const COMPACTION_NOTICE_SUMMARY = '上下文已压缩：批量调用规则不变'

/** Bound a notice line to {@link NOTICE_MAX_CHARS}. */
export function boundNotice(text: string): string {
  return text.length <= NOTICE_MAX_CHARS ? text : `${text.slice(0, NOTICE_MAX_CHARS - 1)}…`
}

/** Build the compacted-context reminder body. */
export function buildCompactionNoticeText(): string {
  return boundNotice(COMPACTION_NOTICE_TEXT)
}

/** Build the one-line notice summary. */
export function buildCompactionNoticeSummary(): string {
  return boundNotice(COMPACTION_NOTICE_SUMMARY)
}

/** Deep-freeze a freshly built message value. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value) as T
}

/**
 * Create the immutable notice message.
 *
 * @param text - model-visible body, already bounded.
 * @param summary - one-line durable summary, already bounded.
 * @returns a frozen user-role message with a fresh identity.
 */
export function createNoticeMessage(text: string, summary: string): HostUserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text', text }],
    source: {
      kind: NOTICE_SOURCE_KIND,
      form: 'notice',
      summary,
    },
  })
}

/**
 * Insert the notice at the natural position of the step's admitted messages.
 *
 * It follows the last user message this step claimed, so the reminder reads as
 * context for the step that resumes after compaction; it appends when no message
 * was claimed.
 *
 * @param messages - decision messages entering the step.
 * @param claimed - proposed messages the step already claimed.
 * @param notice - the message to insert.
 * @returns a new array with exactly one inserted notice.
 */
export function insertNotice(
  messages: readonly HostUserMessage[],
  claimed: readonly HostUserMessage[],
  notice: HostUserMessage,
): HostUserMessage[] {
  const claimedSet = new Set(claimed)
  let index = -1
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]
    if (message !== undefined && claimedSet.has(message)) {
      index = cursor
      break
    }
  }
  if (index < 0) return [...messages, notice]
  return [...messages.slice(0, index + 1), notice, ...messages.slice(index + 1)]
}
