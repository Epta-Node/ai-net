/**
 * Subsequence fuzzy matching with positional scoring.
 *
 * Used by the command palette so that typing any subset of a label's
 * characters finds it: `dsh` → "Dashboard", `tnw` → "Task: New", `wlt` →
 * "Wallet". A plain `includes()` check cannot do that, and a plain subsequence
 * check finds everything without saying which hit is *better* — which is the
 * part that decides what the user sees first.
 *
 * Scoring rewards the things that make a match feel intentional:
 * characters matched consecutively, characters that start a word, and matches
 * that begin near the start of the string. It penalises gaps and a long
 * unmatched prefix.
 */

/** Points for matching a character at all. */
const BASE_MATCH = 4
/** Extra for a character immediately after the previous match. */
const CONSECUTIVE_BONUS = 10
/** Extra for a character that begins a word (`new task`, `NewTask`, `new-task`). */
const WORD_START_BONUS = 9
/** Flat cost of skipping over characters between two matches. */
const GAP_PENALTY = 3
/** Cost per character skipped before the first match, capped by `MAX_LEADING_PENALTY`. */
const LEADING_PENALTY = 1
const MAX_LEADING_PENALTY = 12
/** Awarded when the target is exactly the query. */
const EXACT_BONUS = 40
/** Awarded when the match covers an unbroken run from index 0. */
const PREFIX_BONUS = 20

const WORD_SEPARATORS = new Set([' ', '-', '_', '/', '.', ':', ',', '(', '['])

export interface FuzzyMatch {
  /** Higher is better. Only meaningful relative to other scores for the same query. */
  score: number
  /** Indices into the original `target` that the query matched, ascending. */
  indices: number[]
}

/** Whether `target[index]` begins a word, including a camelCase hump. */
function isWordStart(target: string, index: number): boolean {
  if (index === 0) return true
  const prev = target[index - 1]
  if (WORD_SEPARATORS.has(prev)) return true
  // camelCase / PascalCase boundary: lower-then-upper.
  return prev === prev.toLowerCase() && target[index] !== target[index].toLowerCase()
}

/**
 * Match `query` against `target`, returning the best-scoring alignment, or
 * `null` when `query` is not a subsequence of `target`.
 *
 * An empty query matches everything with score 0 — callers decide whether an
 * empty query should list all candidates or none.
 *
 * Runs in O(query × target); both are short strings in every call site here.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase()
  const rawTarget = target ?? ''
  const t = rawTarget.toLowerCase()

  if (q.length === 0) return { score: 0, indices: [] }
  if (q.length > t.length) return null

  const n = q.length
  const m = t.length

  // scores[i][j] = best score for aligning query[0..i] with query[i] landing on
  // target[j]. `parent` remembers which target index query[i-1] used, so the
  // winning alignment can be walked back for highlight indices.
  const scores: number[][] = []
  const parent: number[][] = []
  const NO_MATCH = Number.NEGATIVE_INFINITY

  for (let i = 0; i < n; i++) {
    scores.push(new Array<number>(m).fill(NO_MATCH))
    parent.push(new Array<number>(m).fill(-1))
  }

  for (let i = 0; i < n; i++) {
    // Best score from the previous query character, over target indices that
    // are at least two behind `j`. Maintained as `j` advances so the inner
    // scan stays linear rather than quadratic.
    let bestGapped = NO_MATCH
    let bestGappedIndex = -1

    for (let j = 0; j < m; j++) {
      if (i > 0 && j >= 2) {
        const candidate = scores[i - 1][j - 2]
        if (candidate > bestGapped) {
          bestGapped = candidate
          bestGappedIndex = j - 2
        }
      }

      if (q[i] !== t[j]) continue

      const charScore = BASE_MATCH + (isWordStart(rawTarget, j) ? WORD_START_BONUS : 0)

      if (i === 0) {
        scores[0][j] = charScore - Math.min(j * LEADING_PENALTY, MAX_LEADING_PENALTY)
        parent[0][j] = -1
        continue
      }

      // Either query[i-1] matched at j-1 (consecutive), or further back (gap).
      const consecutive = scores[i - 1][j - 1]
      let best = NO_MATCH
      let bestFrom = -1

      if (consecutive > NO_MATCH) {
        best = consecutive + charScore + CONSECUTIVE_BONUS
        bestFrom = j - 1
      }
      if (bestGapped > NO_MATCH) {
        const gapped = bestGapped + charScore - GAP_PENALTY
        if (gapped > best) {
          best = gapped
          bestFrom = bestGappedIndex
        }
      }

      scores[i][j] = best
      parent[i][j] = bestFrom
    }
  }

  // Best endpoint for the final query character.
  let bestScore = NO_MATCH
  let bestEnd = -1
  for (let j = 0; j < m; j++) {
    if (scores[n - 1][j] > bestScore) {
      bestScore = scores[n - 1][j]
      bestEnd = j
    }
  }

  if (bestEnd === -1 || bestScore === NO_MATCH) return null

  const indices: number[] = []
  let i = n - 1
  let j = bestEnd
  while (i >= 0 && j >= 0) {
    indices.push(j)
    j = parent[i][j]
    i--
  }
  indices.reverse()

  let score = bestScore
  if (t === q) {
    score += EXACT_BONUS
  } else if (indices[0] === 0 && indices[indices.length - 1] === n - 1) {
    // Unbroken run anchored at the start — a true prefix match.
    score += PREFIX_BONUS
  }

  return { score, indices }
}

/**
 * Best score across several fields of one candidate.
 *
 * Fields are weighted so a hit on a title outranks the same hit buried in a
 * subtitle. Returns `null` when no field matches, so callers can filter and
 * rank in one pass.
 */
export interface WeightedField {
  text: string | undefined | null
  /** Multiplier applied to this field's score. Titles should weigh most. */
  weight: number
}

export interface FuzzyFieldMatch extends FuzzyMatch {
  /** Index into the `fields` array that produced the winning score. */
  fieldIndex: number
}

export function fuzzyMatchFields(
  query: string,
  fields: WeightedField[],
): FuzzyFieldMatch | null {
  let best: FuzzyFieldMatch | null = null

  fields.forEach((field, fieldIndex) => {
    if (!field.text) return
    const match = fuzzyMatch(query, field.text)
    if (!match) return

    const weighted = { ...match, score: match.score * field.weight, fieldIndex }
    if (!best || weighted.score > best.score) {
      best = weighted
    }
  })

  return best
}
