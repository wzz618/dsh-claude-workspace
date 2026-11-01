import type { DirectoryEntry } from './types.ts'

/** Directories first, then case-insensitive name order. */
export function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
  return left.name.localeCompare(right.name)
}

/** Joins an absolute POSIX directory and one child name. */
export function childPath(directory: string, name: string): string {
  const base = directory.replace(/\/+$/, '')
  return base === '' ? `/${name}` : `${base}/${name}`
}
