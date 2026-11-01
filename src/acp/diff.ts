/** One rendered line in a computed diff. */
export interface DiffLine {
  readonly kind: 'context' | 'add' | 'remove'
  readonly text: string
  /** 1-based line number in the old file for context/remove lines. */
  readonly oldLine?: number
  /** 1-based line number in the new file for context/add lines. */
  readonly newLine?: number
}

/** A contiguous region of the diff. */
export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

/** Line-level diff for one `diff` content block. */
export interface DiffResult {
  readonly added: number
  readonly removed: number
  readonly hunks: readonly DiffHunk[]
  /**
   * True when the inputs exceeded the rendering budget. The counts are then
   * line-count estimates and `hunks` is empty, which the UI renders as a
   * summary with an "open file" action.
   */
  readonly truncated: boolean
}

/** Rendering budget: larger inputs get counts only. */
const MAX_CELLS = 1_000_000
const CONTEXT_LINES = 3

/**
 * Computes a line diff between two text fragments.
 *
 * The payload from `claude-agent-acp` is structured text, not a unified diff,
 * so the client must derive line numbers and hunks itself. The LCS table is
 * capped; inputs whose product exceeds the budget return counts only rather
 * than allocating unbounded memory in the Host.
 *
 * @param oldText - Previous file or fragment text.
 * @param newText - Proposed text.
 * @param context - Context lines retained around each change.
 * @returns Counts and hunks, or a truncated summary.
 */
export function diffLines(oldText: string, newText: string, context = CONTEXT_LINES): DiffResult {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const cells = oldLines.length * newLines.length
  if (cells > MAX_CELLS) {
    return { added: newLines.length, removed: oldLines.length, hunks: [], truncated: true }
  }
  const operations = lcsOperations(oldLines, newLines)
  const lines: DiffLine[] = []
  let oldNumber = 1
  let newNumber = 1
  let added = 0
  let removed = 0
  for (const operation of operations) {
    if (operation.kind === 'context') {
      lines.push({ kind: 'context', text: operation.text, oldLine: oldNumber++, newLine: newNumber++ })
    } else if (operation.kind === 'remove') {
      lines.push({ kind: 'remove', text: operation.text, oldLine: oldNumber++ })
      removed += 1
    } else {
      lines.push({ kind: 'add', text: operation.text, newLine: newNumber++ })
      added += 1
    }
  }
  return { added, removed, hunks: buildHunks(lines, context), truncated: false }
}

type Operation = { kind: 'context' | 'add' | 'remove'; text: string }

function lcsOperations(oldLines: readonly string[], newLines: readonly string[]): Operation[] {
  const rows = oldLines.length + 1
  const columns = newLines.length + 1
  const table = new Uint32Array(rows * columns)
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * columns + (j + 1)]! + 1
        : Math.max(table[(i + 1) * columns + j]!, table[i * columns + (j + 1)]!)
    }
  }
  const operations: Operation[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      operations.push({ kind: 'context', text: oldLines[i]! })
      i += 1
      j += 1
    } else if (table[(i + 1) * columns + j]! >= table[i * columns + (j + 1)]!) {
      operations.push({ kind: 'remove', text: oldLines[i]! })
      i += 1
    } else {
      operations.push({ kind: 'add', text: newLines[j]! })
      j += 1
    }
  }
  while (i < oldLines.length) operations.push({ kind: 'remove', text: oldLines[i++]! })
  while (j < newLines.length) operations.push({ kind: 'add', text: newLines[j++]! })
  return operations
}

function buildHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const changed = lines.map((line, index) => (line.kind === 'context' ? -1 : index)).filter((index) => index >= 0)
  if (changed.length === 0) return []
  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(lines.length, index + context + 1)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }
  return ranges.map(({ start, end }) => {
    const slice = lines.slice(start, end)
    const first = slice[0]!
    const oldNumbers = slice.filter((line) => line.oldLine !== undefined)
    const newNumbers = slice.filter((line) => line.newLine !== undefined)
    return {
      oldStart: first.oldLine ?? oldNumbers[0]?.oldLine ?? 0,
      oldLines: oldNumbers.length,
      newStart: first.newLine ?? newNumbers[0]?.newLine ?? 0,
      newLines: newNumbers.length,
      lines: slice,
    }
  })
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
