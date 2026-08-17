/** Durable reservation data backed by the toolkit's Workers Durable Object.
 * All collection reads go through explicit day/guest indexes; no keyspace scan. */
export type BookingStatus = "confirmed" | "cancelled" | "no_show";
export interface Booking { referenceCode: string; guestName: string; contactInfo: string; guestChatId: number; date: string; time: string; partySize: number; tables: string[]; status: BookingStatus; reminderAt: number; }
export interface Availability { seats: number; }
type Stub = { fetch(input: string, init: { method: string; body: string }): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Env = { CHAT_DO?: Namespace };

async function call<T>(ctx: { env?: Env }, action: string, payload: Record<string, unknown> = {}): Promise<T | undefined> {
  const ns = ctx.env?.CHAT_DO;
  if (!ns) return undefined;
  try {
    const stub = ns.get(ns.idFromName("restaurant:default"));
    const response = await stub.fetch("https://do/reservations", { method: "POST", body: JSON.stringify({ action, ...payload }) });
    if (!response.ok) return undefined;
    return await response.json() as T;
  } catch { return undefined; }
}

export function available(ctx: { env?: Env }, date: string, time: string): Promise<Availability | undefined> { return call(ctx, "availability", { date, time }); }
export function createBooking(ctx: { env?: Env }, booking: Booking): Promise<{ ok: boolean; reason?: string } | undefined> { return call(ctx, "create", { booking }); }
export function getBooking(ctx: { env?: Env }, referenceCode: string): Promise<Booking | undefined> { return call(ctx, "get", { referenceCode }); }
export function updateBooking(ctx: { env?: Env }, booking: Booking): Promise<{ ok: boolean } | undefined> { return call(ctx, "update", { booking }); }
export function guestBookings(ctx: { env?: Env }, guestChatId: number): Promise<Booking[] | undefined> { return call(ctx, "guest", { guestChatId }); }
export function upcoming(ctx: { env?: Env }, dates: string[]): Promise<Booking[] | undefined> { return call(ctx, "upcoming", { dates }); }
