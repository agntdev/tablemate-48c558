# TableReserve Bot — Bot specification

**Archetype:** booking

**Voice:** friendly and professional — write every user-facing message, button label, error, and empty state in this voice.

A restaurant reservation bot that shows real-time availability based on tables, opening hours, and sitting duration. Guests can book, reschedule, or cancel via buttons with confirmation codes. Owners receive Telegram-based notifications and have an in-chat dashboard for managing bookings, capacity, and no-shows.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- restaurant guests
- restaurant owner/manager

## Success criteria

- Guests see accurate available time slots
- Bookings are confirmed with unique reference codes
- Owner receives real-time booking updates
- Reminders sent 2 hours before reservations by default

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with booking options
- **Book a table** (button, actor: user, callback: booking:start) — Initiates booking flow for guests
- **Owner View** (button, actor: admin, callback: owner:view) — Opens owner dashboard for managing reservations

## Flows

### booking_flow
_Trigger:_ /start or /book

1. Show main menu
2. Select date
3. Show available times
4. Choose party size
5. Collect guest details
6. Confirm booking with reference code
7. Send calendar button

_Data touched:_ booking, table_inventory, opening_hours

### reschedule_flow
_Trigger:_ Reschedule button from confirmation message

1. Show available times for new slot
2. Select new time
3. Update booking with new details
4. Notify guest and owner

_Data touched:_ booking

### cancel_flow
_Trigger:_ Cancel button from confirmation message

1. Confirm cancellation
2. Update booking status
3. Notify owner

_Data touched:_ booking

### owner_dashboard
_Trigger:_ Owner View button

1. Show upcoming bookings
2. Display today's capacity
3. Allow no-show marking

_Data touched:_ booking, table_inventory

### reminder_flow
_Trigger:_ Scheduled event (pre-booking time)

1. Send reminder message with booking details

_Data touched:_ booking

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram user ID for owner notifications and dashboard access
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **table_inventory** _(retention: persistent)_ — Configurable table types and counts for capacity management
  - fields: table_type, quantity, seats_per_table
- **opening_hours** _(retention: persistent)_ — Daily time ranges for restaurant operations
  - fields: weekday, time_ranges
- **sitting_duration** _(retention: persistent)_ — Time allocated per reservation (default 90 minutes)
  - fields: minutes
- **booking** _(retention: persistent)_ — Reservation records with status tracking
  - fields: guest_name, contact_info, date, time, party_size, tables, status, reference_code
- **reminder_schedule** _(retention: persistent)_ — Time before reservation to send reminders (default 2 hours)
  - fields: minutes_before

## Integrations

- **Telegram** (required) — Bot API messaging and notifications
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- View upcoming bookings (7-day default range)
- See today's remaining capacity by time block
- Mark bookings as no-show
- Receive real-time booking status updates

## Notifications

- New booking confirmation to guest
- Real-time booking status changes to owner
- Reminder message to guest before reservation

## Permissions & privacy

- Guest contact details only visible to owner in private chat
- No external data sharing (SMS/email)

## Edge cases

- Overlapping bookings during rescheduling
- Party size exceeding available seats
- Invalid date/time selections
- Owner marking no-show after reservation start time

## Required tests

- End-to-end booking flow with availability validation
- Owner no-show marking updates both dashboard and guest status
- Reminder message timing accuracy

## Assumptions

- Owner uses a single Telegram account for management
- Sitting duration defaults to 90 minutes if unconfigured
- Opening hours follow weekday-based patterns with single daily range by default
