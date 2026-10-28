import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeHeaderMap } from './headers.js'

const SAFE_STORAGE_PREFIX_V10 = 'v10'
const SAFE_STORAGE_PREFIX_V11 = 'v11'
const LINUX_BASIC_TEXT_PASSWORD = 'peanuts'
const SUPPORTED_PLATFORMS = new Set<string>(['darwin', 'linux', 'win32'])

/** Decrypted routing credentials for the Grok Bot gateway. */
export interface GrokBotGatewaySession {
  /** Gateway base URL, without a trailing slash. */
  gatewayUrl: string
  /** Bearer token for gateway methods. */
  gatewayToken: string
  /** Additional routing headers. */
  gatewayHeaders: Record<string, string>
}

/** Options for locating and decrypting the desktop app's saved session. */
export interface LoadGatewaySessionOptions {
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
  appData?: string
  /** Active account scope from the desktop app, when known. */
  accountScope?: string
  getKeychainPassword?: (platform: NodeJS.Platform) => string
  unprotectData?: (blob: Buffer) => Buffer
}

/** Failure while reading an existing Grok Bot desktop session. */
export class GrokBotSessionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GrokBotSessionError'
    this.code = code
  }
}

function grokBotAppDataPath(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData/Roaming')
    return join(appData, 'Grok Bot')
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config')
    return join(configHome, 'Grok Bot')
  }
  return join(home, 'Library/Application Support/Grok Bot')
}

/** Return the desktop app's gateway descriptor path for one platform. */
export function grokBotGatewayDescriptorPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(grokBotAppDataPath(home, platform, env), 'gateway-descriptor.json')
}

/** Return the desktop app's account-secret path for one platform. */
export function grokBotSandSecretsPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(grokBotAppDataPath(home, platform, env), 'sand-secrets.json')
}

/** Return the desktop app's status marker path for one platform. */
export function grokBotDesktopStatusPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(grokBotAppDataPath(home, platform, env), 'desktop-status.json')
}

/** Whether a Grok Bot desktop gateway descriptor exists on this host. */
export function hasGrokBotGatewaySession(
  options: LoadGatewaySessionOptions = {},
): boolean {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = sessionEnv(options.env ?? process.env, options.appData)
  return SUPPORTED_PLATFORMS.has(platform)
    && existsSync(grokBotGatewayDescriptorPath(home, platform, env))
}

interface EncryptedDescriptorEntry {
  scope: string
  encrypted: string
  savedAtMs?: number
}

function encryptedDescriptorEntry(
  scope: string,
  value: unknown,
): EncryptedDescriptorEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { encrypted?: unknown; savedAtMs?: unknown }
  if (typeof record.encrypted !== 'string' || !record.encrypted) return null
  return {
    scope,
    encrypted: record.encrypted,
    ...(typeof record.savedAtMs === 'number' ? { savedAtMs: record.savedAtMs } : {}),
  }
}

function encryptedPayload(wrapped: unknown, accountScope?: string): string {
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
    throw new GrokBotSessionError(
      'INVALID_DESCRIPTOR',
      'Grok Bot gateway descriptor is not a JSON object.',
    )
  }
  const record = wrapped as {
    version?: unknown
    encrypted?: unknown
    entries?: Record<string, unknown>
  }
  if (record.version !== undefined
    && record.version !== 1
    && record.version !== 2
    && record.version !== 3) {
    throw new GrokBotSessionError(
      'UNSUPPORTED_VERSION',
      `Unsupported Grok Bot gateway descriptor version ${String(record.version)}.`,
    )
  }
  if (record.version === 2 || record.version === 3) {
    const entries = Object.entries(record.entries ?? {})
      .map(([scope, value]) => encryptedDescriptorEntry(scope, value))
      .filter((entry): entry is EncryptedDescriptorEntry => entry !== null)
    if (entries.length === 0) {
      throw new GrokBotSessionError(
        'EMPTY_ENTRIES',
        'Grok Bot gateway descriptor has no saved gateway entries.',
      )
    }
    if (accountScope !== undefined) {
      const selected = entries.find(entry => entry.scope === accountScope)
      if (selected) return selected.encrypted
    }
    if (entries.length === 1) return entries[0]!.encrypted
    const newest = entries
      .filter((entry): entry is EncryptedDescriptorEntry & { savedAtMs: number } =>
        entry.savedAtMs !== undefined)
      .sort((left, right) => right.savedAtMs - left.savedAtMs)[0]
    if (newest) return newest.encrypted
    throw new GrokBotSessionError(
      'AMBIGUOUS_ENTRIES',
      'Grok Bot gateway descriptor has multiple saved gateway entries and no active entry selection.',
    )
  }
  if (typeof record.encrypted !== 'string' || !record.encrypted) {
    throw new GrokBotSessionError(
      'MISSING_ENCRYPTED_PAYLOAD',
      'Grok Bot gateway descriptor is missing an encrypted payload.',
    )
  }
  return record.encrypted
}

function safeStorageKey(password: string, platform: NodeJS.Platform): Buffer {
  const iterations = platform === 'linux' ? 1 : 1003
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
}

/** Decrypt one Chromium Safe Storage value used by the desktop app. */
export function decryptSafeStorageString(
  encryptedBase64: string,
  password: string,
  platform: NodeJS.Platform = 'darwin',
): string {
  const encrypted = Buffer.from(encryptedBase64, 'base64')
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  const linuxBasicText = platform === 'linux' && prefix === SAFE_STORAGE_PREFIX_V10
  const keyring = prefix === SAFE_STORAGE_PREFIX_V10
    || (platform === 'linux' && prefix === SAFE_STORAGE_PREFIX_V11)
  if (!keyring) throw new Error('Unsupported Grok Bot Safe Storage format.')

  const key = safeStorageKey(linuxBasicText ? LINUX_BASIC_TEXT_PASSWORD : password, platform)
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
  return Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]).toString('utf8')
}

/** Decrypt one Windows Chromium Safe Storage value wrapped by DPAPI. */
export function decryptWindowsSafeStorageString(
  encryptedBase64: string,
  key: Buffer,
): string {
  const encrypted = Buffer.from(encryptedBase64, 'base64')
  if (encrypted.subarray(0, 3).toString('latin1') !== SAFE_STORAGE_PREFIX_V10) {
    throw new Error('Unsupported Grok Bot Safe Storage format.')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(3, 15))
  decipher.setAuthTag(encrypted.subarray(-16))
  return Buffer.concat([
    decipher.update(encrypted.subarray(15, -16)),
    decipher.final(),
  ]).toString('utf8')
}

function readKeychainPassword(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return execFileSync(
      'secret-tool',
      ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', 'Grok Bot'],
      { encoding: 'utf8' },
    ).trimEnd()
  }
  return execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage'],
    { encoding: 'utf8' },
  ).trimEnd()
}

function unprotectWithDpapi(blob: Buffer): Buffer {
  const script =
    'Add-Type -AssemblyName System.Security; '
    + '$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); '
    + "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser'))"
  const out = execFileSync(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: blob.toString('base64'), encoding: 'utf8' },
  )
  return Buffer.from(out.trim(), 'base64')
}

function readWindowsSafeStorageKey(
  home: string,
  env: NodeJS.ProcessEnv,
  unprotectData: (blob: Buffer) => Buffer,
): Buffer {
  const path = join(grokBotAppDataPath(home, 'win32', env), 'Local State')
  const parsed: unknown = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : undefined
  const encryptedKey = parsed && typeof parsed === 'object'
    ? (parsed as { os_crypt?: { encrypted_key?: unknown } }).os_crypt?.encrypted_key
    : undefined
  const blob = Buffer.from(typeof encryptedKey === 'string' ? encryptedKey : '', 'base64')
  if (blob.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new GrokBotSessionError(
      'MISSING_SAFE_STORAGE_KEY',
      'Grok Bot Local State has no Safe Storage key.',
    )
  }
  return unprotectData(blob.subarray(5))
}

function sessionEnv(env: NodeJS.ProcessEnv, appData: string | undefined): NodeJS.ProcessEnv {
  if (appData === undefined) return env
  return { ...env, APPDATA: appData }
}

function decryptDesktopSecret(
  encrypted: string,
  options: {
    platform: NodeJS.Platform
    home: string
    env: NodeJS.ProcessEnv
    getKeychainPassword: (platform: NodeJS.Platform) => string
    unprotectData: (blob: Buffer) => Buffer
  },
): string {
  const { platform, home, env, getKeychainPassword, unprotectData } = options
  if (platform === 'win32') {
    return decryptWindowsSafeStorageString(
      encrypted,
      readWindowsSafeStorageKey(home, env, unprotectData),
    )
  }
  const prefix = Buffer.from(encrypted, 'base64').subarray(0, 3).toString('latin1')
  const needsKeychain = !(platform === 'linux' && prefix === SAFE_STORAGE_PREFIX_V10)
  return decryptSafeStorageString(
    encrypted,
    needsKeychain ? getKeychainPassword(platform) : LINUX_BASIC_TEXT_PASSWORD,
    platform,
  )
}

interface GrokBotAccountState {
  activeScope?: string
  accounts: Record<string, Record<string, unknown>>
}

function accountState(value: unknown): GrokBotAccountState | null {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as { active?: unknown; accounts?: unknown }
  const activeScope = typeof record.active === 'string' && record.active
    ? record.active
    : undefined
  if (!record.accounts || typeof record.accounts !== 'object' || Array.isArray(record.accounts)) {
    return { ...(activeScope === undefined ? {} : { activeScope }), accounts: {} }
  }
  const accounts: Record<string, Record<string, unknown>> = {}
  for (const [scope, account] of Object.entries(record.accounts)) {
    if (account && typeof account === 'object' && !Array.isArray(account)) {
      accounts[scope] = account as Record<string, unknown>
    }
  }
  return { ...(activeScope === undefined ? {} : { activeScope }), accounts }
}

function readAccountState(path: string): GrokBotAccountState | null {
  if (!existsSync(path)) return null
  const wrapped: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) return null
  return accountState((wrapped as { 'cursor-accounts'?: unknown })['cursor-accounts'])
}

/** Read the desktop app's currently selected account scope, when available. */
export function loadGrokBotActiveAccountScope(
  options: LoadGatewaySessionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = sessionEnv(options.env ?? process.env, options.appData)
  if (!SUPPORTED_PLATFORMS.has(platform)) return null
  const state = readAccountState(grokBotSandSecretsPath(home, platform, env))
  if (state?.activeScope) return state.activeScope
  const scopes = Object.keys(state?.accounts ?? {})
  return scopes.length === 1 ? scopes[0]! : null
}

/**
 * Decrypt the active account's access token from `sand-secrets.json`.
 * Newer Grok Bot builds use this token to mint a gateway session even before
 * they persist a `gateway-descriptor.json`.
 */
export function loadGrokBotAccessToken(
  options: LoadGatewaySessionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = sessionEnv(options.env ?? process.env, options.appData)
  const getKeychainPassword = options.getKeychainPassword ?? readKeychainPassword
  const unprotectData = options.unprotectData ?? unprotectWithDpapi
  if (!SUPPORTED_PLATFORMS.has(platform)) return null
  const state = readAccountState(grokBotSandSecretsPath(home, platform, env))
  if (!state) return null
  const selected = state.activeScope === undefined
    ? undefined
    : state.accounts[state.activeScope]
  const account = selected ?? (Object.keys(state.accounts).length === 1
    ? Object.values(state.accounts)[0]
    : undefined)
  if (!account) {
    throw new GrokBotSessionError(
      'AMBIGUOUS_ACCOUNTS',
      'Grok Bot account secrets contain multiple accounts and no active account selection.',
    )
  }
  const encrypted = account['cursor-access-token']
  if (typeof encrypted !== 'string' || !encrypted) {
    throw new GrokBotSessionError(
      'MISSING_ACCESS_TOKEN',
      'Grok Bot account secrets do not contain an access token.',
    )
  }
  return decryptDesktopSecret(encrypted, {
    platform,
    home,
    env,
    getKeychainPassword,
    unprotectData,
  })
}

/** Read the running desktop app version from its status marker. */
export function loadGrokBotAppVersion(
  options: LoadGatewaySessionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = sessionEnv(options.env ?? process.env, options.appData)
  if (!SUPPORTED_PLATFORMS.has(platform)) return null
  const path = grokBotDesktopStatusPath(home, platform, env)
  if (!existsSync(path)) return null
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const appVersion = (parsed as { appVersion?: unknown }).appVersion
  return typeof appVersion === 'string' && appVersion.trim()
    ? appVersion.trim()
    : null
}

/**
 * Read, decrypt, and validate the desktop app's saved gateway credentials.
 * @param options - platform, home, environment, and test injection points.
 * @returns the gateway session, or `null` when no descriptor exists.
 */
export function loadGrokBotGatewaySession(
  options: LoadGatewaySessionOptions = {},
): GrokBotGatewaySession | null {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = sessionEnv(options.env ?? process.env, options.appData)
  const getKeychainPassword = options.getKeychainPassword ?? readKeychainPassword
  const unprotectData = options.unprotectData ?? unprotectWithDpapi
  if (!SUPPORTED_PLATFORMS.has(platform)) return null

  const path = grokBotGatewayDescriptorPath(home, platform, env)
  if (!existsSync(path)) return null

  const wrapped: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const accountScope = options.accountScope ?? loadGrokBotActiveAccountScope(options) ?? undefined
  const encrypted = encryptedPayload(wrapped, accountScope)
  const clear = decryptDesktopSecret(encrypted, {
    platform,
    home,
    env,
    getKeychainPassword,
    unprotectData,
  })

  const descriptor: unknown = JSON.parse(clear)
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new GrokBotSessionError(
      'INVALID_DESCRIPTOR',
      'Decrypted Grok Bot gateway descriptor is not a JSON object.',
    )
  }
  const record = descriptor as { baseUrl?: unknown; token?: unknown; headers?: unknown }
  if (typeof record.baseUrl !== 'string' || !record.baseUrl
    || (record.token !== undefined && typeof record.token !== 'string')) {
    throw new GrokBotSessionError(
      'INCOMPLETE_DESCRIPTOR',
      'Decrypted Grok Bot gateway descriptor is incomplete.',
    )
  }
  return {
    gatewayUrl: record.baseUrl.replace(/\/$/, ''),
    gatewayToken: typeof record.token === 'string' ? record.token : '',
    gatewayHeaders: normalizeHeaderMap(record.headers),
  }
}
