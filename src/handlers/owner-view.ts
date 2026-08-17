import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";
import { getBooking, upcoming, updateBooking } from "../reservations/store.js";

registerMainMenuItem({ label: "Owner view", data: "owner:view", order: 90 });
const composer = new Composer<Ctx>();
const workerContext = (ctx: unknown) => ctx as { env?: { CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init: { method: string; body: string }): Promise<Response> } } } };
const clock = () => new Date();
const day = (offset: number) => new Date(clock().getTime() + offset * 86_400_000).toISOString().slice(0, 10);

async function dashboard(ctx: Ctx): Promise<void> {
  const bookings = await upcoming(workerContext(ctx), Array.from({ length: 7 }, (_, i) => day(i)));
  if (!bookings) { await ctx.reply("Your dashboard will be ready when reservation storage is connected.", { reply_markup: inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]) }); return; }
  const active = bookings.filter((b) => b.status === "confirmed");
  const today = active.filter((b) => b.date === day(0));
  const lines = active.length ? active.slice(0, 8).map((b) => `${b.date} ${b.time} · ${b.guestName} · ${b.partySize} guests`).join("\n") : "No upcoming bookings yet — new reservations will appear here.";
  const noShows = today.filter((b) => new Date(`${b.date}T${b.time}:00Z`).getTime() <= clock().getTime()).map((b) => [inlineButton(`Mark ${b.guestName} no-show`, `owner:n:${b.referenceCode}`)]);
  await ctx.reply(`Upcoming bookings\n${lines}\n\nToday's confirmed seats: ${today.reduce((n, b) => n + b.partySize, 0)}.`, { reply_markup: inlineKeyboard([...noShows, [inlineButton("Refresh", "owner:view"), inlineButton("Back to menu", "menu:main")]]) });
}

composer.callbackQuery("owner:view", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx as unknown as Parameters<typeof requireOwner>[0]))) return;
  await dashboard(ctx);
});

composer.callbackQuery(/^owner:n:(TR-[A-Z0-9]{8})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx as unknown as Parameters<typeof requireOwner>[0]))) return;
  const booking = await getBooking(workerContext(ctx), ctx.match[1]);
  if (!booking || booking.status !== "confirmed") { await ctx.reply("That reservation is no longer available to update."); return; }
  if (new Date(`${booking.date}T${booking.time}:00Z`).getTime() > clock().getTime()) { await ctx.reply("You can mark a no-show after the reservation start time."); return; }
  booking.status = "no_show";
  if (!(await updateBooking(workerContext(ctx), booking))) { await ctx.reply("Couldn't update that reservation right now. Try again in a moment."); return; }
  await ctx.reply(`${booking.guestName} is marked as a no-show.`);
  try { await ctx.api.sendMessage(booking.guestChatId, `Your reservation for ${booking.time} has been marked as a no-show.`); } catch { /* guests may block the bot */ }
});

export default composer;
