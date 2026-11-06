// Shared caller-authentication helpers for edge functions deployed with
// --no-verify-jwt. Those functions get no gateway signature check, so a token
// must never be trusted based on claims we decode ourselves.

/** Constant-time string comparison (avoids leaking secrets via timing). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Extract the bearer token from the Authorization header ("" if absent). */
export function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function unverifiedRoleClaim(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1] + "=".repeat((4 - parts[1].length % 4) % 4);
    const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * True only if `token` is a genuine service-role credential.
 *
 * 1. Exact (constant-time) match with this function's SUPABASE_SERVICE_ROLE_KEY
 *    — covers both the legacy JWT and the sb_secret_* formats.
 * 2. A JWT that *claims* role=service_role but isn't byte-identical to the env
 *    key (e.g. the pg_cron Vault copy of an older key) is verified server-side
 *    by calling an Auth admin endpoint with it. The platform checks the
 *    signature; a forged or unsigned token gets 401 and is rejected.
 */
export async function isServiceRoleToken(token: string): Promise<boolean> {
  if (!token) return false;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && safeEqual(token, serviceKey)) return true;
  if (unverifiedRoleClaim(token) !== "service_role") return false;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false; // fail closed
  }
}
