/**
 * Token estimation and prompt trimming (Issue #390).
 *
 * Venice does not expose a tokenizer endpoint, so we use the same
 * chars/4 approximation the VeniceClient already logs. It is deliberately
 * slightly pessimistic (we round *up* and keep a safety margin) because
 * under-estimating an input means silently overspending the task budget.
 */

/** Average characters per token for English + code. */
const CHARS_PER_TOKEN = 4;

/**
 * Safety margin applied to every estimate. Real BPE vocabularies for code
 * (identifiers, JSON, punctuation) tokenize *denser* than prose, so 4 chars
 * per token is optimistic. We inflate by this factor to stay conservative.
 */
const ESTIMATE_SAFETY_FACTOR = 1.1;

/** Marker injected in place of elided content, so the model knows it was cut. */
export const TRUNCATION_MARKER = '\n\n[... context truncated to fit the task token budget ...]\n\n';

/**
 * Estimate the number of tokens in a string.
 *
 * Never returns a negative number, and treats an empty string as 0 tokens so
 * budget arithmetic around blank prompts does not drift.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * ESTIMATE_SAFETY_FACTOR);
}

/**
 * Estimate tokens across a chat message list, accounting for per-message
 * framing overhead that real tokenizers add (role + delimiters, ~4 tokens).
 */
export function estimateMessagesTokens(
  messages: ReadonlyArray<{ role: string; content: string }>
): number {
  const PER_MESSAGE_OVERHEAD_TOKENS = 4;
  return messages.reduce(
    (total, message) => total + estimateTokens(message.content) + PER_MESSAGE_OVERHEAD_TOKENS,
    0
  );
}

/**
 * Invert {@link estimateTokens}: the largest character count whose estimate
 * still fits within `maxTokens`.
 */
function maxCharsForTokens(maxTokens: number): number {
  if (maxTokens <= 0) return 0;
  return Math.floor((maxTokens / ESTIMATE_SAFETY_FACTOR) * CHARS_PER_TOKEN);
}

/**
 * Trim `text` so its estimated token count fits `maxTokens`.
 *
 * Prompts in this system put the system/instruction block first and the most
 * recent context last, with the bulk of upstream results in the middle. So we
 * keep the head and the tail and elide the middle — dropping either end
 * wholesale would throw away the instructions or the immediately preceding
 * turn, which is what most often makes a model produce garbage.
 *
 * Returns the original string unchanged when it already fits, so the common
 * case allocates nothing and callers can treat "did it change?" as meaningful.
 */
export function trimToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxCharsForTokens(maxTokens);
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const markerLen = TRUNCATION_MARKER.length;
  if (markerLen >= maxChars) {
    // No room for real content plus the marker — keep the marker alone so the
    // model is never handed a silently mutilated prompt.
    return TRUNCATION_MARKER;
  }

  // Reserve the marker, then split what is left ~60/40 in favour of the head:
  // the system prompt and task instructions live at the start.
  const budgetChars = maxChars - markerLen;
  const headChars = Math.ceil(budgetChars * 0.6);
  const tailChars = budgetChars - headChars;

  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
  return head + TRUNCATION_MARKER + tail;
}

/**
 * Trim a chat message list to fit `maxTokens`, preserving message order and
 * keeping the system message (which carries the output contract) intact.
 *
 * Non-system messages are trimmed oldest-first, because when a budget forces a
 * choice, the most recent turns are the most useful context.
 */
export function trimMessagesToTokenBudget(
  messages: ReadonlyArray<{ role: string; content: string }>,
  maxTokens: number
): Array<{ role: string; content: string }> {
  if (maxTokens <= 0) return [];
  if (estimateMessagesTokens(messages) <= maxTokens) return [...messages];

  const result = [...messages];

  // Pass 1: trim user/assistant content from the oldest message backwards,
  // shaving a fraction of the overflow at a time so we do not gut a single
  // message when several are over budget together.
  for (let i = result.length - 1; i >= 0; i--) {
    const message = result[i]!;
    if (message.role === 'system') continue;

    const allowance = Math.max(
      1,
      Math.floor(maxTokens * 0.3)
    );
    result[i] = { ...message, content: trimToTokenBudget(message.content, allowance) };

    if (estimateMessagesTokens(result) <= maxTokens) return result;
  }

  // Pass 2: the system prompt alone is over budget. Trim it as a last resort —
  // better a shortened contract than an unbudgeted request.
  const systemIndex = result.findIndex((message) => message.role === 'system');
  if (systemIndex !== -1) {
    const others = result.filter((_, i) => i !== systemIndex);
    const remaining = Math.max(0, maxTokens - estimateMessagesTokens(others));
    result[systemIndex] = {
      ...result[systemIndex]!,
      content: trimToTokenBudget(result[systemIndex]!.content, remaining),
    };
  }

  return result;
}
