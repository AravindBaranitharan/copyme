/**
 * CORS and response helpers.
 *
 * The clients are a VS Code web extension (fetch from a web worker) and a
 * browser page, so every response needs CORS headers or the request fails
 * silently before our code ever sees it. Auth is a bearer token rather than a
 * cookie and clients send `credentials: "omit"`, so a wildcard origin is both
 * safe and necessary — the extension host has no stable origin to allowlist.
 */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function empty(status = 204): Response {
  return new Response(null, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** Reads the bearer token, or null when the header is absent or malformed. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length >= 16 ? token : null;
}

/** SHA-256 as lowercase hex. Used to store token digests rather than tokens. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Length-independent comparison of two equal-length hex strings. Both inputs
 * here are SHA-256 digests, so length never varies with the secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
