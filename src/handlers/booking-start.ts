import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, urlButton } from "../toolkit/index.js";
import { available, createBooking, getBooking, updateBooking, type Booking } from "../reservations/store.js";

registerMainMenuItem({ label: "Book a table", data: "booking:start", order: 10 });

const composer = new Composer<Ctx>();
const SLOT_TIMES = ["11:00", "12:30", "14:00", "17:30", "19:00", "20:30"];
const PARTY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8];
const workerContext = (ctx: unknown) => ctx as { env?: { CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init: { method: string; body: string }): Promise<Response> } } } };

// A single clock seam keeps all date choices testable by replacing this export in
// focused tests; handlers never call Date.now/new Date directly.
export let now = () => new Date();
export function setClock(clock: () => Date): void { now = clock; }

function dateKey(date: Date): string { return date.toISOString().slice(0, 10); }
function dateLabel(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}
function reset(ctx: Ctx): void {
  ctx.session.step = "idle";
  delete ctx.session.date; delete ctx.session.time; delete ctx.session.partySize;
  delete ctx.session.guestName; delete ctx.session.contactInfo;
}
function datesKeyboard() {
  const base = now();
  const rows = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86_400_000);
    const key = dateKey(d);
    return [inlineButton(dateLabel(key), `booking:date:${key}`)];
  });
  rows.push([inlineButton("Back to menu", "menu:main")]);
  return inlineKeyboard(rows);
}
function timeKeyboard(date: string) {
  return inlineKeyboard([
    ...SLOT_TIMES.map((time) => [inlineButton(time, `booking:time:${time}`)]),
    [inlineButton("Choose another date", "booking:start")],
  ]);
}
function partyKeyboard() {
  const rows = [] as ReturnType<typeof inlineButton>[][];
  for (let i = 0; i < PARTY_SIZES.length; i += 4) rows.push(PARTY_SIZES.slice(i, i + 4).map((n) => inlineButton(String(n), `booking:party:${n}`)));
  rows.push([inlineButton("Choose another time", "booking:times")]);
  return inlineKeyboard(rows);
}
function confirmationKeyboard() {
  return inlineKeyboard([[inlineButton("Confirm booking", "booking:confirm"), inlineButton("Start over", "booking:start")]]);
}
function bookingKeyboard(referenceCode: string) {
  return inlineKeyboard([[inlineButton("Reschedule", `booking:res:${referenceCode}`), inlineButton("Cancel", `booking:cancel:${referenceCode}`)]]);
}
function confirmedKeyboard(booking: Booking) {
  const start = `${booking.date.replaceAll("-", "")}T${booking.time.replace(":", "")}00Z`;
  const end = new Date(new Date(`${booking.date}T${booking.time}:00Z`).getTime() + 90 * 60_000).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".000", "");
  const calendar = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("TableReserve reservation")}&dates=${start}/${end}&details=${encodeURIComponent(`Reference ${booking.referenceCode}`)}`;
  return inlineKeyboard([[urlButton("Add to calendar", calendar)], [inlineButton("Reschedule", `booking:res:${booking.referenceCode}`), inlineButton("Cancel", `booking:cancel:${booking.referenceCode}`)]]);
}
function referenceCode(): string { return `TR-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`; }
function reminderAt(date: string, time: string): number { return new Date(`${date}T${time}:00Z`).getTime() - 2 * 60 * 60_000; }
async function notifyOwner(ctx: Ctx, text: string): Promise<void> {
  const owner = adminChatId(ctx as Ctx & { env?: Record<string, unknown> });
  if (!owner) return;
  try { await ctx.api.sendMessage(owner, text); } catch { /* a blocked owner notification must not break a reservation */ }
}
function edit(ctx: Ctx, text: string, replyMarkup: ReturnType<typeof inlineKeyboard>) {
  return ctx.editMessageText(text, { reply_markup: replyMarkup }).catch(() => ctx.reply(text, { reply_markup: replyMarkup }));
}

composer.callbackQuery("booking:start", async (ctx) => {
  await ctx.answerCallbackQuery(); reset(ctx);
  await edit(ctx, "Pick the day you'd like to visit.", datesKeyboard());
});
composer.callbackQuery(/^booking:date:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const date = ctx.match[1];
  if (date < dateKey(now())) return edit(ctx, "That day has passed. Pick a future date.", datesKeyboard());
  ctx.session.date = date;
  await edit(ctx, `Choose a time for ${dateLabel(date)}.`, timeKeyboard(date));
});
composer.callbackQuery(/^booking:time:(\d{2}:\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.date || !SLOT_TIMES.includes(ctx.match[1])) return edit(ctx, "Choose your date first.", datesKeyboard());
  ctx.session.time = ctx.match[1];
  await edit(ctx, "How many guests are coming?", partyKeyboard());
});
composer.callbackQuery("booking:times", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.date) return edit(ctx, "Pick a day first.", datesKeyboard());
  await edit(ctx, `Choose a time for ${dateLabel(ctx.session.date)}.`, timeKeyboard(ctx.session.date));
});
composer.callbackQuery(/^booking:party:([1-8])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.date || !ctx.session.time) return edit(ctx, "Choose a date and time first.", datesKeyboard());
  const partySize = Number(ctx.match[1]);
  const slot = await available(workerContext(ctx), ctx.session.date, ctx.session.time);
  if (slot && slot.seats < partySize) return edit(ctx, "That time can't fit your party. Choose another time.", timeKeyboard(ctx.session.date));
  ctx.session.partySize = partySize; ctx.session.step = "name";
  await edit(ctx, "What name should we put on the reservation?", inlineKeyboard([[inlineButton("Start over", "booking:start")]]));
});
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step === "name") {
    const name = ctx.message.text.trim();
    if (name.length < 2 || name.length > 80) { await ctx.reply("Enter the name your party will use, then try again."); return; }
    ctx.session.guestName = name; ctx.session.step = "contact";
    await ctx.reply("Share a phone number or email so the restaurant can reach you if needed.", { reply_markup: { force_reply: true, input_field_placeholder: "Phone number or email" } });
    return;
  }
  if (ctx.session.step === "contact") {
    const contact = ctx.message.text.trim();
    if (contact.length < 3 || contact.length > 120) { await ctx.reply("That contact detail doesn't look right. Try a phone number or email."); return; }
    ctx.session.contactInfo = contact; ctx.session.step = "confirm";
    await ctx.reply(`Review your table for ${ctx.session.partySize}:\n${dateLabel(ctx.session.date!)} at ${ctx.session.time}\nName: ${ctx.session.guestName}\nContact: ${contact}`, { reply_markup: confirmationKeyboard() });
    return;
  }
  return next();
});
composer.callbackQuery("booking:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.step !== "confirm" || !ctx.session.date || !ctx.session.time || !ctx.session.partySize || !ctx.session.guestName || !ctx.session.contactInfo) {
    return edit(ctx, "That booking has expired. Start again to choose a table.", datesKeyboard());
  }
  const booking: Booking = { referenceCode: referenceCode(), guestName: ctx.session.guestName, contactInfo: ctx.session.contactInfo, guestChatId: ctx.chat!.id, date: ctx.session.date, time: ctx.session.time, partySize: ctx.session.partySize, tables: [], status: "confirmed", reminderAt: reminderAt(ctx.session.date, ctx.session.time) };
  const saved = await createBooking(workerContext(ctx), booking);
  if (!saved) return edit(ctx, "Reservations are not set up yet. Ask the restaurant to finish its booking setup.", inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]));
  if (!saved.ok) return edit(ctx, "That table was just taken. Choose another time.", timeKeyboard(booking.date));
  await edit(ctx, `Your table is confirmed.\n${dateLabel(booking.date)} at ${booking.time} for ${booking.partySize}.\nReference: ${booking.referenceCode}`, confirmedKeyboard(booking));
  await notifyOwner(ctx, `New reservation: ${booking.guestName}, ${booking.partySize} guests on ${booking.date} at ${booking.time}.`);
  reset(ctx);
});

composer.callbackQuery(/^booking:cancel:(TR-[A-Z0-9]{8})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const booking = await getBooking(workerContext(ctx), ctx.match[1]);
  if (!booking || booking.guestChatId !== ctx.chat?.id || booking.status !== "confirmed") return edit(ctx, "That reservation is no longer available to change.", inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]));
  await edit(ctx, `Cancel your table for ${dateLabel(booking.date)} at ${booking.time}?`, inlineKeyboard([[inlineButton("Cancel reservation", `booking:cancelok:${booking.referenceCode}`), inlineButton("Keep reservation", `booking:keep:${booking.referenceCode}`)]]));
});
composer.callbackQuery(/^booking:keep:(TR-[A-Z0-9]{8})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await edit(ctx, "Your reservation is unchanged.", bookingKeyboard(ctx.match[1]));
});
composer.callbackQuery(/^booking:cancelok:(TR-[A-Z0-9]{8})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const booking = await getBooking(workerContext(ctx), ctx.match[1]);
  if (!booking || booking.guestChatId !== ctx.chat?.id || booking.status !== "confirmed") return edit(ctx, "That reservation is already closed.", inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]));
  booking.status = "cancelled";
  if (!(await updateBooking(workerContext(ctx), booking))) return edit(ctx, "Couldn't cancel that reservation right now. Try again in a moment.", bookingKeyboard(booking.referenceCode));
  await edit(ctx, "Your reservation has been cancelled.", inlineKeyboard([[inlineButton("Book a table", "booking:start")]]));
  await notifyOwner(ctx, `Reservation cancelled: ${booking.guestName} on ${booking.date} at ${booking.time}.`);
});
composer.callbackQuery(/^booking:res:(TR-[A-Z0-9]{8})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const booking = await getBooking(workerContext(ctx), ctx.match[1]);
  if (!booking || booking.guestChatId !== ctx.chat?.id || booking.status !== "confirmed") return edit(ctx, "That reservation is no longer available to change.", inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]));
  ctx.session.date = booking.date; ctx.session.step = "idle";
  await edit(ctx, `Choose a new time for ${dateLabel(booking.date)}.`, inlineKeyboard([...SLOT_TIMES.map((time) => [inlineButton(time, `booking:res-time:${booking.referenceCode}:${time}`)]), [inlineButton("Keep current time", `booking:keep:${booking.referenceCode}`)]]));
});
composer.callbackQuery(/^booking:res-time:(TR-[A-Z0-9]{8}):(\d{2}:\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const booking = await getBooking(workerContext(ctx), ctx.match[1]);
  if (!booking || booking.guestChatId !== ctx.chat?.id || booking.status !== "confirmed") return edit(ctx, "That reservation is no longer available to change.", inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]));
  const slot = await available(workerContext(ctx), booking.date, ctx.match[2]);
  if (!slot || slot.seats < booking.partySize) return edit(ctx, "That time can't fit your party. Choose another time.", bookingKeyboard(booking.referenceCode));
  booking.time = ctx.match[2]; booking.reminderAt = reminderAt(booking.date, booking.time);
  if (!(await updateBooking(workerContext(ctx), booking))) return edit(ctx, "Couldn't move that reservation right now. Try again in a moment.", bookingKeyboard(booking.referenceCode));
  await edit(ctx, `Your table is now at ${booking.time} on ${dateLabel(booking.date)}.`, bookingKeyboard(booking.referenceCode));
  await notifyOwner(ctx, `Reservation moved: ${booking.guestName} is now booked on ${booking.date} at ${booking.time}.`);
});

export default composer;
