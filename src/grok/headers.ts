/** Normalize header objects from the app descriptor, env, or EnsureSandBox. */
export function normalizeHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined || entry === '') continue
    out[key.toLowerCase()] = String(entry)
  }
  return out
}

/** Parse the optional JSON header map from an environment variable. */
export function parseGatewayHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GROK_BOT_GATEWAY_HEADERS must be a JSON object')
  }
  return normalizeHeaderMap(parsed)
}

/** Project gateway headers from an EnsureSandBox response. */
export function headersFromEnsureSandbox(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const record = body as Record<string, unknown>
  const mapped = normalizeHeaderMap(record.gatewayHeaders ?? record.gateway_headers)
  if (Object.keys(mapped).length > 0) return mapped
  const token = record.anyrunNetworkToken ?? record.anyrun_network_token ?? record.networkToken
  return token ? { 'x-anyrun-network-token': String(token) } : {}
}

/** Read deployment headers without treating malformed JSON as an empty value. */
export function headersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return parseGatewayHeaders(env.GROK_BOT_GATEWAY_HEADERS)
}

/** Merge session and deployment headers, with deployment values winning. */
export function mergeGatewayHeaders(
  sessionHeaders: Record<string, string>,
  envHeaders: Record<string, string>,
): Record<string, string> {
  return { ...sessionHeaders, ...envHeaders }
}

/** Headers for authenticated Grok gateway methods. */
export function requestHeaders(session: {
  gatewayToken: string
  gatewayHeaders: Record<string, string>
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${session.gatewayToken}`,
    ...session.gatewayHeaders,
  }
}

/** Headers for the Cursor token exchange that creates a gateway session. */
export function ensureSandboxHeaders(
  accessToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    authorization: `Bearer ${accessToken}`,
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': env.SAND_CLIENT_VERSION ?? '0.20.0',
    'x-sand-box-namespace': env.SAND_BOX_NAMESPACE ?? 'prod',
  }
}
