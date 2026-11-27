export interface SanitizeParts {
  cfg: Record<string, any>
  remoteAttrs: string[]
  remoteHrefTags: string[]
  inputAllowAttrs: string[]
  svgProfiles: Record<string, boolean>
  svgForbidTags: string[]
}

export interface SanitizeState {
  blockRemote: boolean
  remoteAllow: string
  placeholder: () => string
  blockedLabel: string
}

export function splitConfig(config: Record<string, any>): SanitizeParts
export function isRemoteSrc(href: string): boolean
export function remoteAllowed(href: string, allow: string): boolean
export function createState(
  blockRemote: boolean,
  remoteAllow: string,
  placeholder: () => string,
  blockedLabel?: string
): SanitizeState
export function withState<T>(state: SanitizeState, fn: () => T): T
export function installHooks(DOMPurify: any, parts: SanitizeParts): void
export function sanitizeWith(
  DOMPurify: any,
  parts: SanitizeParts,
  html: string,
  state: SanitizeState,
  overrides?: Record<string, any>
): string
export function svgConfig(parts: SanitizeParts, allowStyle?: boolean): Record<string, any>
export function mermaidSvgConfig(parts: SanitizeParts): Record<string, any>
export function peleSvgConfig(parts: SanitizeParts): Record<string, any>
export function stripSvgStyleUrls(code: string): string
export function stripSvgExternalRefs(code: string): string
