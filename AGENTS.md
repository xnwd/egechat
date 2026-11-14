# AGENTS.md

This document describes the project for developers and AI agents working on this codebase.

## Project Overview

**Muhabbet** is a Turkish-language group chat site. Anyone picks a nickname + color (stored in localStorage, no accounts), creates a room or joins one via a short invite code, and chats in real time. All UI copy is Turkish — keep it that way.

### Architecture

- `db/schema.ts` – Drizzle schema: `rooms` (unique short `code`, `admin_client_id` = room creator), `messages` (per room, serial id used as cursor, `reply_to_id`, soft delete via `deleted_at`), `presence` (composite PK room+client, `last_seen`, `typing_at`, `token_hash`), `room_bans` (composite PK room+client), `message_images` (base64 photo per message, FK cascade), `rate_limits` (spam counters), `device_bans` (device-level bans, see below), `room_code_history` (old room codes), `call_members` + `call_signals` (voice call / screen share signalling). `presence` also stores hashed `device_token_hash`/`fp_hash`/`ip_hash`. `messages.has_image` flags photo messages; `presence.avatar`/`avatar_rev` hold the member's profile photo.
- `db/index.ts` – Drizzle client using `drizzle-orm/netlify-db` (Netlify Database). Migrations live in `netlify/database/migrations/` and are generated with `npx drizzle-kit generate --name <name>`; never hand-edit or apply them.
- `src/lib/chat.functions.ts` – all server functions (any `@tanstack/react-start/server` import must stay inside `createServerOnlyFn`, e.g. `clientIp`, or the client build fails) (`createRoom`, `getRoom`, `pollRoom`, `sendMessage`, `deleteMessage`, `banMember`, `unbanMember`, `changeRoomCode`, `setAvatar`, `setTyping`, and the call functions `joinCall`, `leaveCall`, `pollCall`, `sendSignal`, `setSharing`), validated with zod.
- `src/lib/spam.ts` – pure spam/image helpers (link flood, repeated characters, duplicate normalising, image data-URL + magic-byte validation). Covered by `spam.test.ts`.
- `src/lib/image.ts` – browser-side photo resize/re-encode to JPEG (strips EXIF) used for profile photos and chat photos.
- `src/routes/api.image.$code.$id.ts`, `src/routes/api.avatar.$code.$clientId.ts` – serve chat photos / profile photos as image bytes.
- `src/lib/device.ts` – browser device token (localStorage + cookie + IndexedDB) and fingerprint, sent with every identity-bearing call (`identity.device`).
- `src/lib/call.ts` – `useCall` hook: WebRTC mesh voice call + screen share, signalling via `sendSignal`/`pollCall`.
- `src/components/chat/call-panel.tsx` – call bar / participants / controls / screen viewer.
- `src/lib/profile.ts` – client-side profile and recent-rooms hooks (localStorage, read in effects to avoid hydration mismatches).
- `src/routes/index.tsx` – landing page: profile setup, create/join room tabs, recent rooms.
- `src/routes/oda/$code.tsx` – chat room screen (loader 404s for unknown codes, join gate when no profile, message list, sidebar/sheet with invite + online list, composer).
- `src/components/chat/` – Avatar, Logo, ProfileFields.

### Non-obvious decisions

- **Spam protection** (`chat.functions.ts`): `hit()` is an atomic fixed-window counter in `rate_limits`, checked per client+room and per IP (`x-nf-client-connection-ip`) by `enforceLimit()` for messages (5/10s), photos (4/min), avatars (6/10min) and room creation (5/h). Content rules live in `spam.ts` (max 2 links, no 15+ repeated characters); identical messages from one client within 30s are rejected. Errors are Turkish sentences; the client shows them via `friendlyError()`.
- **Photos**: the browser shrinks to ≤1280px JPEG (≤700k chars base64), the server re-validates type + magic bytes and stores base64 in `message_images`. Deleting a message or banning its author deletes the photo row. Profile photos (256px square) live in localStorage (`Profile.avatar` + `avatarRev`) and are synced to each room's `presence` row; `pollRoom` returns `avatars` (clientId → rev) so clients build cache-busted `/api/avatar/...?v=rev` URLs.
- **2-second message gap**: the composer disables sending for 2s (`SEND_COOLDOWN_MS`); the server enforces it with `hit('gap:...', 1, 1800)` (200ms jitter tolerance).
- **Troll strikes + auto-ban**: every rejected spam attempt (link flood, repeated chars, gap violation, duplicate, rate-limit hit, avatar/call/share churn) goes through `rejectWithStrike()`. 6 strikes in 2 minutes per device token → `autoBan()`: site-wide `device_bans` row (`scope_room_id` NULL, `auto` true), room ban, purge of everything the person posted in every room. Room admins are exempt from auto-bans. The room admin can undo a wrong ban with "Banı kaldır" (`unbanMember` deletes the matching device bans that started in this room).
- **Device bans ("HWID")**: browsers cannot read a hardware ID, so a device is recognised by a persistent token (kept in 3 places) OR by fingerprint + IP together (fingerprint alone is shared by identical phones and is never trusted alone). Admin bans create a room-scoped `device_bans` row; automatic bans are site-wide. A banned device that returns with a new clientId is turned away in `authenticate()` and written to that room's ban list so the admin can see/undo it. Only hashes are stored.
- **Room code change**: `changeRoomCode` (admin only, 5/h) swaps `rooms.code` and stores the old one in `room_code_history`. New people with the old code get 404; members already in the room get `movedTo` from `pollRoom` (via `followCodeChange`) and the client navigates to the new code.
- **Voice call / screen share**: media goes browser-to-browser (WebRTC mesh, max 6 people, Google STUN; optional TURN via `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`). Netlify has no WebSockets, so `pollCall` (700ms) carries heartbeat + offers/answers/ICE. Offers use perfect negotiation; the newer joiner starts each connection. `pollRoom` returns `callMembers` for the "someone is in a call" indicator. Every peer has one sendrecv audio transceiver, so changing the microphone mid-call is `audioSender.replaceTrack()` (no renegotiation) and the mute state survives it. Speakers are chosen with `HTMLMediaElement.setSinkId` (Chrome/Edge; hidden on Safari/iOS). The settings popover (`DeviceSettings` in `call-panel.tsx`) lists devices from `enumerateDevices` and refreshes on `devicechange`; if autoplay blocks the sound, a "Sesi aç" banner retries `play()`.
- **Ban = purge**: `banMember` always soft-deletes all of the person's messages, deletes their photos and avatar. `pollRoom` also purges leftovers of older bans on the first poll of a page load.

- Real-time is done by **polling** `pollRoom` every 2s (6s when the tab is hidden) with an `after` message-id cursor. The same call upserts presence; "online" = seen in the last 20s, "typing" = `typing_at` within 5s.
- Identity is a random `clientId` (public, visible on messages) plus a private `secret` (both in localStorage, no accounts). Only the SHA-256 of the secret is stored (`presence.token_hash`); the first request for a clientId in a room claims it, later requests must present the same secret. Admin, delete and ban checks all go through `authenticate()` in `chat.functions.ts`, so a copied clientId is never enough. Anyone with a room code can still join.
- Room admin = creator (`rooms.admin_client_id`). Admin can delete anyone's message and ban/unban members. Bans are by clientId and also by device (see "Device bans").
- Delete: "Herkesten sil" soft-deletes (`deleted_at`, body blanked; shown as a tombstone, synced via `deletedIds` in `pollRoom`). "Benden sil" only hides the message in localStorage (`useHiddenMessages`).
- Replies: `messages.reply_to_id`; the server attaches a short preview, the client re-resolves it from loaded messages so deleted targets show "Silinmiş mesaj".
- Fonts: Bricolage Grotesque (headings, `font-display`) and DM Sans (body), loaded from Google Fonts in `__root.tsx`. Palette is warm cream + tangerine in `src/styles.css`.

### Tech Stack

| Layer         | Technology                                          |
| ------------- | --------------------------------------------------- |
| Framework     | TanStack Start                                      |
| Frontend      | React 19, TanStack Router                           |
| Build         | Vite 8                                              |
| Styling       | Tailwind CSS 4, theme variables in `src/styles.css` |
| UI Components | shadcn/ui (Radix UI + Tailwind)                     |
| Toasts        | sonner                                              |
| Icons         | lucide-react                                        |
| Language      | TypeScript 6.0 (strict mode)                        |
| Deployment    | Netlify, via `@netlify/vite-plugin-tanstack-start`  |

## Directory Structure

```
├── public
│   └── favicon.ico
├── src
│   ├── components
│   │   ├── error-pages.tsx # Themed 404 and route error pages with home/retry actions.
│   │   └── ui          # shadcn/ui controls, overlays, feedback, forms, and tables.
│   ├── examples
│   │   └── validated-form.tsx # Unmounted form pattern with validation, pending, error, and success states.
│   ├── lib
│   │   └── utils.ts    # cn() helper for merging Tailwind classes.
│   ├── routes
│   │   ├── __root.tsx  # HTML shell, <head> metadata (siteName, siteDescription), the tooltip provider, and the toast container.
│   │   └── index.tsx   # Home route (/): placeholder page to replace.
│   ├── router.tsx      # Creates the router from the generated route tree.
│   └── styles.css      # Tailwind import, theme variables for light and dark mode, base styles.
├── components.json     # shadcn/ui config, used by `npx shadcn add`.
├── netlify.toml        # Build command, publish directory, dev server ports.
├── package.json
├── tsconfig.json
└── vite.config.ts      # Vite path aliases and Tailwind, Netlify, TanStack Start, React plugins.
```

`src/routeTree.gen.ts` is generated by the router plugin when the dev server or build runs. Don't edit it.

Shared framework skill source lives in `frameworks/tanstack-start-react/.claude/skills` in this repository, separate from the standalone starter. Consult the matching framework/Netlify skills when available in a generated app; don't assume the starter contains a `.claude` directory.

## Key Concepts

### File-Based Routing

Route files in `src/routes/` define pages and endpoints:

- `__root.tsx` wraps every page.
- `index.tsx` is `/`.
- `about.tsx` would be `/about`.
- `api.*.ts` files are server API endpoints. See the `tanstack-start-api-routes` skill.

### Theme Variables

Colors and corner radius are CSS variables in `src/styles.css` (`--background`, `--foreground`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--radius`, and more), with a second set under `.dark`. Tailwind exposes them as classes such as `bg-primary`, `text-muted-foreground`, and `border-border`.

Set these variables for the product before you build any page. In components, use the variable classes instead of raw colors like `bg-white` or `text-gray-600`, so the whole site changes when a variable changes.

### UI Components

Ready-made components are in `src/components/ui/`. Use them before writing your own, and restyle them through the theme variables or their variants. Add more with `npx shadcn add <name>`. Show a toast by calling `toast()` from `sonner`; the container is already mounted in `__root.tsx`. `TooltipProvider` is mounted there too, so `Tooltip` works anywhere without its own provider.

| Need               | Components                                                         |
| ------------------ | ------------------------------------------------------------------ |
| Actions and status | Button, Badge, Progress, Skeleton, Alert, Sonner                   |
| Forms              | Input, Textarea, Label, Checkbox, RadioGroup, Switch, Select, Form |
| Overlays and menus | Dialog, Sheet, Popover, DropdownMenu, Tooltip                      |
| Content and layout | Card, Tabs, Accordion, Separator, Table                            |

Use `Form` with React Hook Form and the Zod resolver. Start from `src/examples/validated-form.tsx`; it isn't mounted or connected to a backend. Its required `onSubmit` callback must reject on failure. See [the form pattern](docs/forms.md) for HTTP submission and error handling.

Use Sheet for a mobile menu and DropdownMenu for short action lists. Give Dialog and Sheet an accessible title and description. Pair Checkbox, RadioGroup, Switch, and inputs with visible labels. Reserve tables for tabular data and wrap them in their provided scroll container.

### Design Choices

Set the product's palette, heading/body fonts, and layout before building its screens. Use an explicit user design when supplied; otherwise choose defaults that fit the product. Keep Basic's placeholder until you replace it with the requested product.

- Set `--font-body` and `--font-heading` in `src/styles.css`. Use `font-display` for headings when the product needs a separate heading font.
- Use `max-w-content` for a page container and `max-w-reading` for long text. Keep consistent horizontal padding, such as `px-4 sm:px-6`, and a small repeated spacing scale, such as `gap-4`, `gap-6`, and `py-12`.
- Keep one main heading per page and a clear heading order. Use muted text for supporting copy, not essential low-contrast labels.
- Preserve focus rings. Give icon-only buttons an accessible name. Ensure actions work with a keyboard and on narrow screens.
- Use short color/opacity transitions. Add `motion-reduce:transition-none` or `motion-reduce:animate-none` when adding motion; don't make essential content depend on animation.
- Provide loading, empty, error, and success states for each data-driven screen. Skeletons should follow the shape of the content they replace.

### Routing and Server Data

Router types are registered in `src/router.tsx`, so use typed `Link` destinations and route parameters. The root route supplies the themed 404 page; the router's default error component supplies the safe retry/home page, including child-route SSR failures. Use `throw notFound()` for absent records; keep unexpected failures on the error path. See [routing conventions](src/routes/README.md).

Start with route loaders and server functions for server data. Validate server-function input with `.validator(...)`, keep secrets on the server, and handle HTTP failures before returning data. See [the data-fetching pattern](docs/data-fetching.md). Add TanStack Query only when client-side caching, mutations, or background refresh are needed.

### Browser Storage

Pages are rendered on the server first, where `window` and `localStorage` don't exist. Read `localStorage` inside `useEffect`, not during render or in a `useState` initializer, or the first render will differ from the server HTML and React will log a hydration error.

## Configuration Files

| File             | Purpose                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `vite.config.ts` | Vite path aliases and Tailwind, Netlify, TanStack Start, React plugins                           |
| `tsconfig.json`  | Strict TypeScript, with the `@/*` alias for `src/*`                                              |
| `netlify.toml`   | Builds with `vite build`, publishes `dist/client`, dev server on port 8888 proxying Vite on 3000 |

## Development Commands

Use Node 22.13+ on the Node 22 line, Node 24, or Node 26+. The installed lint and test tools set this minimum alongside the framework.

```bash
npm run dev        # Start the Vite dev server on port 3000
npm run build      # Production build
npm run typecheck  # Type-check with tsc; the build doesn't
npm run lint       # Check TypeScript and React Hooks rules
npm run format:check # Check formatting
npm run format     # Format project files
npm test           # Run local form, control, and error page tests
npm run preview    # Preview the production build
```

## Conventions

- Components: PascalCase. Utilities and hooks: camelCase. Route files: kebab-case.
- Import from `src` with the `@/` alias.
- TypeScript fails on unused locals and parameters, so remove what you don't use.
- Use React hooks for state.
- Run the dev server or build once to generate route types before type-checking a fresh copy.
- Run build, typecheck, lint, format:check, and tests before reporting completion. Verify changed user flows locally; a passing build doesn't prove an interaction works.

## Application Name

Set the product's name and description in `src/routes/__root.tsx`:

- `siteName` is the page title and the title shown when the link is shared.
- `siteDescription` is the meta description and the description shown when the link is shared.

Then replace the placeholder heading and text in `src/routes/index.tsx`.
