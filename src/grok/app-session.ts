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

function encryptedPayload(wrapped: unknown): string {
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) {
    throw new GrokBotSessionError(
      'INVALID_DESCRIPTOR',
      'Grok Bot gateway descriptor is not a JSON object.',
    )
  }
  const record = wrapped as {
    version?: unknown
    encrypted?: unknown
    entries?: Record<string, { encrypted?: unknown }>
  }
  if (record.version !== undefined && record.version !== 1 && record.version !== 2) {
    throw new GrokBotSessionError(
      'UNSUPPORTED_VERSION',
      `Unsupported Grok Bot gateway descriptor version ${String(record.version)}.`,
    )
  }
  let encrypted: unknown
  if (record.version === 2) {
    const entries = Object.values(record.entries ?? {})
    if (entries.length === 0) {
      throw new GrokBotSessionError(
        'EMPTY_ENTRIES',
        'Grok Bot gateway descriptor has no saved gateway entries.',
      )
    }
    if (entries.length > 1) {
      throw new GrokBotSessionError(
        'AMBIGUOUS_ENTRIES',
        'Grok Bot gateway descriptor has multiple saved gateway entries and no active entry selection.',
      )
    }
    encrypted = entries[0]?.encrypted
  } else {
    encrypted = record.encrypted
  }
  if (typeof encrypted !== 'string' || !encrypted) {
    throw new GrokBotSessionError(
      'MISSING_ENCRYPTED_PAYLOAD',
      'Grok Bot gateway descriptor is missing an encrypted payload.',
    )
  }
  return encrypted
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
  const encrypted = encryptedPayload(wrapped)
  let clear: string
  if (platform === 'win32') {
    clear = decryptWindowsSafeStorageString(
      encrypted,
      readWindowsSafeStorageKey(home, env, unprotectData),
    )
  } else {
    const prefix = Buffer.from(encrypted, 'base64').subarray(0, 3).toString('latin1')
    const needsKeychain = !(platform === 'linux' && prefix === SAFE_STORAGE_PREFIX_V10)
    clear = decryptSafeStorageString(
      encrypted,
      needsKeychain ? getKeychainPassword(platform) : LINUX_BASIC_TEXT_PASSWORD,
      platform,
    )
  }

  const descriptor: unknown = JSON.parse(clear)
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new GrokBotSessionError(
      'INVALID_DESCRIPTOR',
      'Decrypted Grok Bot gateway descriptor is not a JSON object.',
    )
  }
  const record = descriptor as { baseUrl?: unknown; token?: unknown; headers?: unknown }
  if (typeof record.baseUrl !== 'string' || !record.baseUrl
    || typeof record.token !== 'string' || !record.token) {
    throw new GrokBotSessionError(
      'INCOMPLETE_DESCRIPTOR',
      'Decrypted Grok Bot gateway descriptor is incomplete.',
    )
  }
  return {
    gatewayUrl: record.baseUrl.replace(/\/$/, ''),
    gatewayToken: record.token,
    gatewayHeaders: normalizeHeaderMap(record.headers),
  }
}
