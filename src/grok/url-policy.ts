/**
 * Credential URL policy derived from grok-bot-cli.
 *
 * Gateway credentials may go to Cursor gateway hosts; EnsureSandBox backend
 * credentials may go only to Cursor API hosts. Loopback is explicit opt-in,
 * and test mode can never reach a live host.
 */

function truthy(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = (env[name] ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isCursorApiHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'cursor.sh'
    || host === 'cursor.com'
    || host.endsWith('.cursor.sh')
    || host.endsWith('.cursor.com')
}

function isCursorGatewayHostname(hostname: string): boolean {
  return isCursorApiHostname(hostname) || hostname.toLowerCase().endsWith('.cursorvm.com')
}

function trimmedUrl(rawUrl: string): string {
  return rawUrl.replace(/\/$/, '')
}

/**
 * Validate a credential-bearing URL before any request is made.
 * @param rawUrl - candidate gateway or backend URL.
 * @param kind - credential class; backend URLs exclude cursorvm hosts.
 * @param env - environment used for explicit local/break-glass opt-ins.
 * @returns normalized URL without a trailing slash.
 */
export function assertAllowedCredentialUrl(
  rawUrl: string,
  kind: 'gateway' | 'backend' = 'gateway',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const label = kind === 'backend' ? 'backend URL' : 'gateway URL'
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid ${label}.`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Rejected ${label}: userinfo is not allowed.`)
  }

  if (truthy('GROK_BOT_TEST', env) || env.NODE_ENV === 'test') {
    if (!isLocalHostname(parsed.hostname)
      || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error(
        `Rejected ${label} host "${parsed.hostname}": test mode only allows http(s) loopback URLs.`,
      )
    }
    return trimmedUrl(rawUrl)
  }

  if (truthy('GROK_BOT_ALLOW_ANY_GATEWAY', env)) {
    return trimmedUrl(rawUrl)
  }

  if (isLocalHostname(parsed.hostname)) {
    if (kind === 'backend') {
      throw new Error(
        `Rejected backend URL host "${parsed.hostname}". EnsureSandBox backends must be https on *.cursor.sh / *.cursor.com.`,
      )
    }
    if (!truthy('GROK_BOT_ALLOW_LOCAL_GATEWAY', env)) {
      throw new Error(
        `Rejected ${label} host "${parsed.hostname}". Set GROK_BOT_ALLOW_LOCAL_GATEWAY=1 to permit loopback gateways.`,
      )
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Rejected ${label}: loopback gateways must use http or https.`)
    }
    return trimmedUrl(rawUrl)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Rejected ${label}: only https is allowed (got ${parsed.protocol}).`)
  }
  const allowed = kind === 'backend'
    ? isCursorApiHostname(parsed.hostname)
    : isCursorGatewayHostname(parsed.hostname)
  if (!allowed) {
    const expected = kind === 'backend'
      ? '*.cursor.sh / *.cursor.com'
      : '*.cursor.sh / *.cursor.com / *.cursorvm.com'
    throw new Error(
      `Rejected ${label} host "${parsed.hostname}". Expected ${expected}, or set GROK_BOT_ALLOW_LOCAL_GATEWAY=1 / GROK_BOT_ALLOW_ANY_GATEWAY=1.`,
    )
  }
  return trimmedUrl(rawUrl)
}

/** Redact credential-shaped values from errors before they reach logs or tools. */
export function redactSecrets(text: string): string {
  let value = String(text)
  value = value.replace(
    /(^|[\s,{;])((?:set-cookie|cookie)\s*[:=]\s*)([^\n;]+?)(?=\s+(?:set-cookie|cookie|authorization|proxy-authorization)\b|\s*$)/gi,
    '$1$2<redacted>',
  )
  value = value.replace(
    /(^|[\s,{;])((?:authorization|proxy-authorization)\s*[:=]\s*)(\S+(?:\s+\S+)?)/gi,
    '$1$2<redacted>',
  )
  value = value.replace(/Bearer\s+[A-Za-z0-9._+/=-]+/gi, 'Bearer <redacted>')
  value = value.replace(
    /(["']?(?:authorization|gatewayToken|gateway_token|access_token|accessToken|refresh_token|refreshToken|token|x-anyrun-network-token|cookie|set-cookie)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
    '$1<redacted>',
  )
  value = value.replace(/(x-anyrun-network-token\s*[=:]\s*)(\S+)/gi, '$1<redacted>')
  return value
}
