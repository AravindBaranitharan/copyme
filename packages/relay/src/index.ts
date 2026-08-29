import { ChannelRoom } from "./channel";
import { json, error, preflight, bearer } from "./http";

export { ChannelRoom };

export interface Env {
  CHANNEL: DurableObjectNamespace;
  /** How long an entry survives. Shorter is safer — see the README. */
  ENTRY_TTL_SECONDS?: string;
  MAX_ENTRIES_PER_CHANNEL?: string;
  MAX_ENTRY_BYTES?: string;
  MAX_WRITES_PER_MINUTE?: string;
}

/** Channel ids are base64url HKDF output: 22 characters for 128 bits. */
const CHANNEL_ID = /^[A-Za-z0-9_-]{16,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return preflight();

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    // The root is a common landing spot for a human poking at the URL. Say what
    // this is rather than a bare 404, without revealing anything about channels.
    if (path === "/") {
      return json({
        service: "copyme-relay",
        note: "This is an API, not a website. It stores end-to-end encrypted clipboard entries and cannot read them.",
        endpoints: ["/healthz", "/v1/channels/{channelId}/entries"],
      });
    }

    if (path === "/healthz") {
      return json({ ok: true, service: "copyme-relay", time: new Date().toISOString() });
    }

    const match = path.match(/^\/v1\/channels\/([^/]+)(\/entries(?:\/latest)?)?$/);
    if (!match) return error(404, "Not found.");

    const channelId = decodeURIComponent(match[1]);
    if (!CHANNEL_ID.test(channelId)) return error(400, "Malformed channel id.");

    const token = bearer(request);
    if (!token) return error(401, "Missing bearer token.");

    const action = resolveAction(request.method, match[2] ?? "");
    if (!action) return error(405, "Method not allowed.");

    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(channelId));
    const forwarded = new URL("https://channel/");
    forwarded.searchParams.set("action", action);
    forwarded.searchParams.set("token", token);

    return stub.fetch(
      new Request(forwarded.toString(), {
        method: request.method === "POST" ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: request.method === "POST" ? await request.text() : undefined,
      }),
    );
  },
};

function resolveAction(method: string, suffix: string): string | null {
  if (suffix === "/entries/latest") return method === "GET" ? "latest" : null;
  if (suffix === "/entries") {
    if (method === "GET") return "list";
    if (method === "POST") return "push";
    return null;
  }
  if (suffix === "") return method === "DELETE" ? "destroy" : null;
  return null;
}
