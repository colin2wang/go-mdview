export type SanitizeCase = readonly [input: string, name: string]
export type PreserveCase = readonly [input: string, needle: string, name: string]
export type RemotePatternCase = readonly [href: string, allow: string, allowed: boolean, name: string]

export const DANGEROUS_SUBSTRINGS: readonly string[]
export const HOSTILE_CASES: readonly SanitizeCase[]
export const BYPASS_CASES: readonly SanitizeCase[]
export const BENIGN_CASES: readonly PreserveCase[]
export const REMOTE_PATTERN_CASES: readonly RemotePatternCase[]
