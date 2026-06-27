import { verifyWithJwks } from 'hono/jwt'

export type JwtPayload = {
  sub: string
  email?: string
  phone?: string
  role?: string
  iat?: number
  exp?: number
  [key: string]: unknown
}

// This Supabase project signs access tokens with asymmetric keys (ES256), so we
// verify against the project's published JWKS public keys rather than a shared
// HS256 secret. Keys are cached and refetched on a verification miss (rotation).
const jwksUri = () => `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`

let cachedKeys: unknown[] | null = null

async function fetchKeys(): Promise<unknown[]> {
  const res = await fetch(jwksUri())
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const data = (await res.json()) as { keys: unknown[] }
  cachedKeys = data.keys
  return data.keys
}

export async function verifySupabaseToken(token: string): Promise<JwtPayload> {
  const keys = cachedKeys ?? (await fetchKeys())
  try {
    return (await verifyWithJwks(token, {
      keys: keys as never,
      allowedAlgorithms: ['ES256'],
    })) as JwtPayload
  } catch {
    // Possible key rotation — refetch once and retry before giving up.
    const fresh = await fetchKeys()
    return (await verifyWithJwks(token, {
      keys: fresh as never,
      allowedAlgorithms: ['ES256'],
    })) as JwtPayload
  }
}
