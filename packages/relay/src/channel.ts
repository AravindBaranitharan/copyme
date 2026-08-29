import { json, empty, error, sha256Hex, timingSafeEqual } from "./http";
import type { Env } from "./index";

/** One stored entry. The relay never learns what any of it means. */
interface StoredEntry {
  seq: number;
  v: number;
  epoch: number;
  deviceId: string;
  nonce: string;
  ciphertext: string;
  contentType: string;
  createdAt: number;
}

interface Meta {
  /** SHA-256 of the bearer token, bound on first use. Never the token itself. */
  tokenHash: string;
  createdAt: number;
}

const META_KEY = "meta";
const SEQ_KEY = "seq";
const ENTRY_PREFIX = "entry:";

/** Zero-padded so lexicographic key order matches chronological order. */
const entryKey = (seq: number) => ENTRY_PREFIX + String(seq).padStart(16, "0");

/**
 * A single CopyMe channel.
 *
 * Every request for a given channel id routes to this one instance, so a device
 * that sends and immediately reads back always sees its own write. That
 * consistency is the reason for a Durable Object rather than plain KV storage.
 */
export class ChannelRoom implements DurableObject {
  private writes: number[] = [];

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  private num(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private get ttlMs() { return this.num(this.env.ENTRY_TTL_SECONDS, 3600) * 1000; }
  private get maxEntries() { return this.num(this.env.MAX_ENTRIES_PER_CHANNEL, 50); }
  private get maxBytes() { return this.num(this.env.MAX_ENTRY_BYTES, 96 * 1024); }
  private get writesPerMinute() { return this.num(this.env.MAX_WRITES_PER_MINUTE, 120); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const token = url.searchParams.get("token") ?? "";

    if (!(await this.authorize(token))) {
      return error(401, "Invalid token for this channel.");
    }

    switch (action) {
      case "push": return this.push(request);
      case "latest": return this.latest();
      case "list": return this.list();
      case "destroy": return this.destroy();
      default: return error(404, "Unknown action.");
    }
  }

  /**
   * Trust on first use: the first token to touch a channel claims it, and every
   * later request must match. Channel id and auth token come from separate HKDF
   * labels, so learning an id — from a log, say — does not yield the token.
   * This binding is what makes that separation worth anything.
   */
  private async authorize(token: string): Promise<boolean> {
    if (token.length < 16) return false;
    const hash = await sha256Hex(token);
    const meta = await this.state.storage.get<Meta>(META_KEY);

    if (!meta) {
      await this.state.storage.put<Meta>(META_KEY, { tokenHash: hash, createdAt: Date.now() });
      return true;
    }
    return timingSafeEqual(meta.tokenHash, hash);
  }

  /** In-memory window. Resets when the instance hibernates, which is fine. */
  private rateLimited(): boolean {
    const cutoff = Date.now() - 60_000;
    this.writes = this.writes.filter((t) => t > cutoff);
    if (this.writes.length >= this.writesPerMinute) return true;
    this.writes.push(Date.now());
    return false;
  }

  private async push(request: Request): Promise<Response> {
    if (this.rateLimited()) return error(429, "Too many writes. Slow down.");

    let body: Partial<StoredEntry>;
    try {
      body = await request.json();
    } catch {
      return error(400, "Body must be JSON.");
    }

    const { nonce, ciphertext, deviceId } = body;
    if (typeof nonce !== "string" || typeof ciphertext !== "string" || !nonce || !ciphertext) {
      return error(400, "Both nonce and ciphertext are required.");
    }
    if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(deviceId)) {
      return error(400, "A valid deviceId is required.");
    }
    if (nonce.length + ciphertext.length > this.maxBytes) {
      return error(413, `Entry exceeds the ${Math.floor(this.maxBytes / 1024)} KB limit.`);
    }
    // Payloads are base64url. Rejecting anything else keeps arbitrary bytes out.
    if (!/^[A-Za-z0-9_-]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) {
      return error(400, "Nonce and ciphertext must be base64url.");
    }

    const seq = ((await this.state.storage.get<number>(SEQ_KEY)) ?? 0) + 1;
    const entry: StoredEntry = {
      seq,
      v: typeof body.v === "number" ? body.v : 1,
      epoch: typeof body.epoch === "number" ? body.epoch : 0,
      deviceId,
      nonce,
      ciphertext,
      contentType: typeof body.contentType === "string" ? body.contentType : "text/plain",
      createdAt: Date.now(),
    };

    await this.state.storage.put(entryKey(seq), entry);
    await this.state.storage.put(SEQ_KEY, seq);
    await this.prune();

    return json({ ok: true, seq, createdAt: entry.createdAt }, 201);
  }

  private async latest(): Promise<Response> {
    const newest = (await this.liveEntries()).at(-1);
    if (!newest) return error(404, "This channel is empty.");
    return json(newest);
  }

  private async list(): Promise<Response> {
    const entries = await this.liveEntries();
    return json({ entries: entries.reverse() }); // newest first
  }

  private async destroy(): Promise<Response> {
    await this.state.storage.deleteAll();
    return empty(204);
  }

  /** Entries still inside the TTL, oldest first. Expired ones swept in passing. */
  private async liveEntries(): Promise<StoredEntry[]> {
    const stored = await this.state.storage.list<StoredEntry>({ prefix: ENTRY_PREFIX });
    const cutoff = Date.now() - this.ttlMs;
    const live: StoredEntry[] = [];
    const dead: string[] = [];

    for (const [key, entry] of stored) {
      if (entry.createdAt < cutoff) dead.push(key);
      else live.push(entry);
    }
    if (dead.length) await this.state.storage.delete(dead);
    return live;
  }

  private async prune(): Promise<void> {
    const live = await this.liveEntries();
    const excess = live.length - this.maxEntries;
    if (excess > 0) {
      await this.state.storage.delete(live.slice(0, excess).map((e) => entryKey(e.seq)));
    }
  }
}
