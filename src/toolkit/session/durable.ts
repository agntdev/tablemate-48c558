/**
 * Durable Object session storage + exact-time reminders for the Cloudflare
 * Workers runtime (docs/cloudflare/new-projects-on-cf.md §1, §10).
 *
 * One ChatDO instance per chat (addressed by idFromName("chat:<chatId>")). It
 * holds:
 *   - the grammY session (strongly consistent, serialized per chat for free);
 *   - that chat's reminders, with a single Durable Object ALARM armed to the
 *     earliest due one. The alarm fires at the wall-clock time even when nothing
 *     is running — this is what replaces per-bot cron + Redis (PoC: 0–1 ms).
 *
 * NONE of this is imported by the Node/long-poll entry or the test harness, so
 * `node:fs`, Redis, and this file's Workers-only globals never load there.
 */

import type { StorageAdapter } from "grammy";

// Minimal shapes so this file type-checks without pulling @cloudflare/workers-types
// into the Node build. The real bindings are provided by the Workers runtime.
export interface DOState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}
export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}
export interface DOStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}
export interface WorkerEnv {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  CHAT_DO: DONamespace;
  DB?: unknown; // D1 binding (app data); see AGENTS.md
  BOT_TELEMETRY_URL?: string;
  BOT_TELEMETRY_SECRET?: string;
  BOT_TELEMETRY_SALT?: string;
}

interface Reminder {
  at: number; // epoch ms
  chatId: number | string;
  text: string;
}

interface ReservationBooking {
  referenceCode: string; guestName: string; contactInfo: string; guestChatId: number;
  date: string; time: string; partySize: number; tables: string[];
  status: "confirmed" | "cancelled" | "no_show"; reminderAt: number;
}
interface ReservationRequest { action: string; date?: string; time?: string; booking?: ReservationBooking; referenceCode?: string; guestChatId?: number; dates?: string[]; }
const TABLES = [{ type: "two-seat", quantity: 10, seats: 2 }, { type: "four-seat", quantity: 10, seats: 4 }];
const SITTING_MS = 90 * 60_000;

/**
 * createDurableSessionStorage — a grammY StorageAdapter that routes each session
 * key to its own ChatDO instance. Pass to buildBot({ storage }) in the Worker.
 */
export function createDurableSessionStorage<T>(env: WorkerEnv): StorageAdapter<T> {
  const stub = (key: string): DOStub => {
    // A missing binding otherwise surfaces as the opaque "Cannot read
    // properties of undefined (reading 'get')" — live: canary #2 shipped with
    // the binding misnamed CHATDO and every update threw exactly that.
    if (!env.CHAT_DO) {
      throw new Error(
        "CHAT_DO Durable Object binding is missing — the deploy must bind class ChatDO as CHAT_DO (see cf.meta.json)",
      );
    }
    return env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + key));
  };
  return {
    async read(key: string): Promise<T | undefined> {
      const r = await stub(key).fetch("https://do/session", { method: "GET" });
      if (r.status === 204) return undefined;
      return (await r.json()) as T;
    },
    async write(key: string, value: T): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "PUT", body: JSON.stringify(value) });
    },
    async delete(key: string): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "DELETE" });
    },
  };
}

/**
 * remindAt — schedule a one-shot reminder DM for `chatId` at `whenEpochMs`.
 * Backed by the chat's ChatDO alarm; fires within a millisecond of the target
 * even if the Worker was idle. Call from a handler under the Workers runtime
 * (via ctx.env). No-op-safe: a scheduling failure never throws into the update.
 */
export async function remindAt(
  env: WorkerEnv,
  chatId: number | string,
  whenEpochMs: number,
  text: string,
): Promise<void> {
  try {
    const stub = env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + chatId));
    await stub.fetch("https://do/remind", {
      method: "POST",
      body: JSON.stringify({ at: whenEpochMs, chatId, text } satisfies Reminder),
    });
  } catch {
    /* best-effort: a reminder we couldn't schedule must not break the reply */
  }
}

async function tg(token: string, method: string, payload: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * ChatDO — the per-chat Durable Object. Its class name is referenced in
 * cf.meta.json (new_sqlite_classes) so the deployer registers the migration.
 * Constructed by the runtime with (state, env).
 */
export class ChatDO {
  constructor(
    private readonly state: DOState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Session storage (routed here by createDurableSessionStorage).
    if (url.pathname === "/session") {
      if (request.method === "GET") {
        const v = await this.state.storage.get<unknown>("session");
        if (v === undefined) return new Response(null, { status: 204 });
        return Response.json(v);
      }
      if (request.method === "PUT") {
        await this.state.storage.put("session", await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        await this.state.storage.delete("session");
        return new Response(null, { status: 204 });
      }
    }

    // Schedule a reminder + (re)arm the alarm to the earliest due one.
    if (url.pathname === "/remind" && request.method === "POST") {
      const rem = (await request.json()) as Reminder;
      const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
      list.push(rem);
      await this.state.storage.put("reminders", list);
      await this.rearm(list);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/reservations" && request.method === "POST") {
      const req = await request.json() as ReservationRequest;
      return Response.json(await this.reservation(req));
    }

    return new Response("not found", { status: 404 });
  }

  // Fires at the earliest reminder's wall-clock time. Sends every due reminder,
  // drops them, and re-arms for whatever remains.
  async alarm(): Promise<void> {
    const now = Date.now();
    const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
    const due = list.filter((r) => r.at <= now);
    const rest = list.filter((r) => r.at > now);
    for (const r of due) {
      const match = r.text.match(/^reminder:([A-Z0-9-]+)$/);
      const booking = match ? await this.state.storage.get<ReservationBooking>(`booking:${match[1]}`) : undefined;
      if (match && booking?.status === "confirmed") {
        await tg(this.env.BOT_TOKEN, "sendMessage", { chat_id: r.chatId, text: `Reminder: your table for ${booking.partySize} is at ${booking.time} today. We look forward to seeing you.` });
      } else if (!match) {
        await tg(this.env.BOT_TOKEN, "sendMessage", { chat_id: r.chatId, text: r.text });
      }
    }
    await this.state.storage.put("reminders", rest);
    await this.rearm(rest);
  }

  private async rearm(list: Reminder[]): Promise<void> {
    if (list.length === 0) return;
    const next = Math.min(...list.map((r) => r.at));
    const current = await this.state.storage.getAlarm();
    if (current === null || next < current) {
      await this.state.storage.setAlarm(next);
    }
  }

  private async reservation(req: ReservationRequest): Promise<unknown> {
    if (req.action === "get" && req.referenceCode) return (await this.state.storage.get<ReservationBooking>(`booking:${req.referenceCode}`)) ?? null;
    if (req.action === "availability" && req.date && req.time) {
      const bookings = await this.bookingsForDay(req.date);
      const free = availableTables(bookings, req.time);
      return { seats: free.reduce((n, table) => n + table.seats, 0) };
    }
    if (req.action === "create" && req.booking) {
      const choices = allocateTables(availableTables(await this.bookingsForDay(req.booking.date), req.booking.time), req.booking.partySize);
      if (!choices) return { ok: false, reason: "full" };
      const existing = await this.state.storage.get<ReservationBooking>(`booking:${req.booking.referenceCode}`);
      if (existing) return { ok: false, reason: "retry" };
      const dayKey = `day:${req.booking.date}`;
      const day = (await this.state.storage.get<string[]>(dayKey)) ?? [];
      req.booking.tables = choices;
      await this.state.storage.put({ [`booking:${req.booking.referenceCode}`]: req.booking, [dayKey]: [...day, req.booking.referenceCode], [`guest:${req.booking.guestChatId}`]: [...((await this.state.storage.get<string[]>(`guest:${req.booking.guestChatId}`)) ?? []), req.booking.referenceCode] });
      if (req.booking.reminderAt > Date.now()) {
        const reminders = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
        reminders.push({ at: req.booking.reminderAt, chatId: req.booking.guestChatId, text: `reminder:${req.booking.referenceCode}` });
        await this.state.storage.put("reminders", reminders); await this.rearm(reminders);
      }
      return { ok: true };
    }
    if (req.action === "update" && req.booking) { await this.state.storage.put(`booking:${req.booking.referenceCode}`, req.booking); return { ok: true }; }
    if (req.action === "guest" && req.guestChatId !== undefined) {
      const ids = (await this.state.storage.get<string[]>(`guest:${req.guestChatId}`)) ?? [];
      return (await Promise.all(ids.map((id) => this.state.storage.get<ReservationBooking>(`booking:${id}`)))).filter((b): b is ReservationBooking => b !== undefined);
    }
    if (req.action === "upcoming" && req.dates) return (await Promise.all(req.dates.map((d) => this.bookingsForDay(d)))).flat();
    return { ok: false };
  }

  private async bookingsForDay(date: string): Promise<ReservationBooking[]> {
    const ids = (await this.state.storage.get<string[]>(`day:${date}`)) ?? [];
    return (await Promise.all(ids.map((id) => this.state.storage.get<ReservationBooking>(`booking:${id}`)))).filter((b): b is ReservationBooking => b !== undefined);
  }
}

function overlaps(existing: string, requested: string): boolean {
  const minutes = (value: string) => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
  return Math.abs(minutes(existing) - minutes(requested)) < SITTING_MS / 60;
}

interface PhysicalTable { id: string; seats: number; }
function allTables(): PhysicalTable[] {
  return TABLES.flatMap((kind) => Array.from({ length: kind.quantity }, (_, i) => ({ id: `${kind.type}-${i + 1}`, seats: kind.seats })));
}
function availableTables(bookings: ReservationBooking[], time: string): PhysicalTable[] {
  const occupied = new Set(bookings.filter((b) => b.status === "confirmed" && overlaps(b.time, time)).flatMap((b) => b.tables));
  return allTables().filter((table) => !occupied.has(table.id));
}
function allocateTables(tables: PhysicalTable[], partySize: number): string[] | undefined {
  // Prefer the smallest sufficient combination, preserving larger tables.
  const sorted = [...tables].sort((a, b) => a.seats - b.seats);
  for (let count = 1; count <= sorted.length; count++) {
    const pick = sorted.slice(0, count);
    if (pick.reduce((sum, table) => sum + table.seats, 0) >= partySize) return pick.map((table) => table.id);
  }
  return undefined;
}
