# Dani on G2

Your messages and your assistant's to-do list, cleared from your glasses.

Dani on G2 is an [Even Hub](https://www.evenrealities.com) app for Even Realities G2. Dani reads what needs an answer (Telegram chats you pick, plus mail, calendar and file requests) and prepares each reply or action as a short draft. The glasses show the message and the draft. You approve, skip or reject with the temple or the R1 ring, or say your own reply by voice. **Nothing is sent until you approve it**, and every outcome leaves a receipt.

Built for the Even Realities Heads Up hackathon. Track 1 (Messaging & News: Telegram) and Track 4 (AI Assistants & Work). Submitted by Dan Lab.

![Draft screen](demo/steps/03-detail.png)

## Why it fits the judging

| What the judges look for | What Dani does |
| --- | --- |
| Read, then write, in seconds | One message and one drafted reply per screen. Approve is one click; the reply goes out to Telegram. |
| Usefulness at a glance | Only chats you allow. A busy channel becomes one digest line you mark read. |
| Voice or tap | Click to approve. Or choose **Reply by voice**, speak, click when done, check the new draft, approve. |
| A real, working integration | The Telegram Bot API (read with `getUpdates`, send with `sendMessage`), tested end to end against a fake Telegram server. |
| Safe by design | Allow-list of chats, no send without a click, the incoming text is treated as untrusted, secrets never reach the glasses app. |

## What you see on the glasses

| Screen | What you see | Input |
| --- | --- | --- |
| Brief | How many actions wait, the next one | Click to open the queue or receipts |
| Queue | One line per item, tagged TG / MAIL / CAL / DRIVE | Scroll, click to open |
| Draft | Title, sender, **what they said**, then the reply Dani drafted, then Approve / Skip / Reject / Reply by voice | Click a row, or long-press for the same menu. Double-click goes back |
| Listening | "Say your reply" | Click when done. Double-click cancels |
| Running / Receipt | What is being sent, then Done with a reference | Click to continue |
| Failed | Why it did not run (for example "chat not found"), then Retry / Skip it | Click |
| Receipts | The last four outcomes | Double-click or click to go back |

Receipts are saved in the Even App's local storage (last 200). A saved approval, skip or reject hides that item on later loads.

## Track 1: Telegram

`server/telegram.mjs` is a small Telegram bridge that runs next to the backend.

1. It long-polls the Bot API for new messages.
2. Only chats in `TELEGRAM_CHAT_IDS` are read. Messages from any other chat are ignored, and so are bots and anything that is not text. An empty list reads nothing.
3. Each message becomes a queue item with the sender, the message text, and a drafted reply.
4. Channel posts are grouped into one **digest** item per poll (first five lines plus a count). Approving a digest sends nothing, it only marks it read.
5. On approve, the backend calls `sendMessage` as a reply to the original message, with exactly the text you approved. Skip and reject send nothing. If Telegram refuses, the item stays in the queue and the glasses show the error with Retry.

The drafter (`server/drafter.mjs`) asks any OpenAI-compatible model (OpenRouter by default) for one to three sentences. The incoming message is passed as quoted data, never as instructions, and the draft is capped at 280 characters. If no key is set, or the model fails, the draft is a plain "Got it, thanks. I'll get back to you shortly." You always see the draft before anything is sent.

Set up the bot:

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Add the bot to your group or channel (admin rights are needed to read a channel). In a group, use `/setprivacy` to turn privacy mode off if it should see every message.
3. Send a message in that chat, then open `https://api.telegram.org/bot<token>/getUpdates` and read the chat `id` (groups are negative numbers).
4. Put the token and the chat id in `.env` (see below).

A bot can only read chats it belongs to. It cannot read your personal Telegram account.

## Track 4: AI assistants and work

The same queue carries mail, calendar and file actions. Any assistant (Claude, ChatGPT, OpenRouter agents, your own) adds a draft with one call, and the glasses become the approval step:

```bash
curl -X POST localhost:8787/queue -H 'authorization: Bearer change-me' \
  -d '{"id":"m1","title":"Reply: standup","from":"Team","context":"Notes?","draft":"Notes are in the doc.","app":"gmail"}'
```

On approve, the backend POSTs `{ "item": ... }` to `DANI_HANDLER_URL` (your Gmail, Calendar or Drive worker); a 2xx reply counts as done and may return `{ "ref": "..." }`. If it fails the item stays pending and Retry works. **If no handler is set, approve only records the decision**, the reply says `recorded_only`, and the glasses show "Recorded. Nothing was sent." The reference backend does not send mail or edit calendars by itself.

## Voice replies

On a draft, choose **Reply by voice**. The app records from the glasses microphone (16 kHz mono, at most 25 seconds), wraps it as a WAV, and sends it to your backend. The backend sends it to Sarvam speech to text and returns the transcript, which replaces the draft. You check it and approve. Nothing is sent by speaking alone.

The row only appears when the backend reports voice support (`SARVAM_API_KEY` is set). If speech fails, the draft stays as it was and the glasses show why.

## Run it

Needs Node 22.9 or newer.

```bash
npm ci
cp .env.example .env     # add your keys, every value is documented inside
npm start                # backend on :8787
npm run dev              # app on :5173
```

Open the app in the Even Hub simulator or the Even App with the backend in the URL:

```
http://127.0.0.1:5173/?backend=http://127.0.0.1:8787&token=<DANI_TOKEN>
```

Everything is configured in `.env`:

| Variable | What it does |
| --- | --- |
| `DANI_TOKEN` | Shared secret for the glasses app. Set it before the backend is reachable from the internet. |
| `PORT`, `HOST`, `DANI_DATA` | Where the backend listens and stores its queue and audit log. |
| `DANI_HANDLER_URL` | Webhook that performs approved items that have no handler of their own. |
| `TELEGRAM_BOT_TOKEN` | Turns the Telegram bridge on. |
| `TELEGRAM_CHAT_IDS` | Chats the bot may read (ids or `@usernames`). Empty reads nothing. |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | AI reply drafts. Default endpoint is OpenRouter. |
| `SARVAM_API_KEY`, `SARVAM_MODEL`, `SARVAM_LANGUAGE` | Voice replies. Defaults are `saaras:v4` and automatic language detection. |

On a phone, the app can only call hosts listed under `permissions` in `app.json`. It lists `http://127.0.0.1:8787` for local work. Add your own HTTPS backend URL there before you pack the app for a real device.

### Demo mode (no keys, no accounts)

`?demo=1` loads synthetic items from `public/queue.sample.json` (a Telegram reply, a Telegram digest, mail, calendar and file actions) and a simulated executor that sends nothing and touches no account. The header says `SAMPLE DATA`. The simulated voice flow ignores the recording and returns a fixed sentence. One file share fails once on purpose so the retry screen can be shown.

```bash
npm run dev
npm run sim        # Even Hub simulator in demo mode (Linux: scripts/sim-linux.sh)
npm run demo       # plays demo/flow.json against the simulator and saves screenshots
sh scripts/make-video.sh
```

With no `?backend=` and no `?demo=1` the app shows "NOT CONNECTED". It never falls back to fake data.

### Package for the Even App

```bash
npm run pack       # builds, then writes dani.ehpk from app.json
```

## How it is built

```
src/model.ts       types: ActionItem, Receipt, Executor, Mic
src/store.ts       pure reducer: screen + input -> next screen (no I/O)
src/view.ts        state -> page description (576x288, container limits enforced)
src/glasses.ts     page -> Even Hub SDK containers; SDK events -> app input
src/controller.ts  runs approvals and voice replies, saves receipts
src/mic.ts         glasses microphone capture, plus a silent demo mic
src/adapters.ts    HTTP source and executor (timeouts, error bodies); demo-only sample source and executor
src/validate.ts    validates untrusted backend payloads
server/app.mjs     reference backend: queue, audit log, per-app handlers, dictate endpoint
server/telegram.mjs, drafter.mjs, stt.mjs   Telegram bridge, reply drafting, Sarvam speech to text
```

The reducer and view have no SDK imports, so they are tested directly. Built with [`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) 0.0.16 and tested in [`@evenrealities/evenhub-simulator`](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) 0.9.5.

### Backend contract

- `GET /queue` returns `{ "items": ActionItem[], "voice": boolean }`
- `POST /queue` adds one item or `{ "items": [...] }`
- `POST /actions/{id}/approve` runs the item's handler and returns `{ "ref": "..." }`, or a non-2xx reply with `{ "error": "..." }` (shown on the glasses, with Retry)
- `POST /actions/{id}/skip` and `/reject` record the decision
- `POST /actions/{id}/dictate` takes a WAV body and returns `{ "draft": "..." }`; 501 if voice is not set up
- `GET /log` returns the audit entries

`ActionItem` is `{ id, title, draft, from?, context?, app? }`. Payloads are validated: malformed or duplicate items are dropped, and the list is capped at the glasses' 20-row limit. Requests time out after 10 seconds. If the backend is down the glasses show an offline screen with "Try again".

## Tests

```bash
npm test
```

77 tests, all against fakes (no network, no keys): the reducer and screens, every screen checked by the SDK's own container validator, the backend, the Telegram bridge against a fake Bot API (allow-list, bots ignored, digests, reply-to, errors without leaking the token), the drafter against a fake model, Sarvam speech to text, the voice flow end to end, and a replay of the demo script against the app.

## Status and limits

- Tested in unit and integration tests against fake Telegram, model and speech services. It has not been run against live Telegram or Sarvam from this repo until you add keys, and not on physical G2 glasses.
- The glasses UI is checked by the SDK validator and by reducer tests. Pixels are checked by running the simulator, which needs a desktop session.
- The simulator reports the same source for temple and ring input, so ring behavior is untested.
- Telegram: bots read only chats they belong to. Voice and Telegram need a backend you host and an HTTPS URL on a real device.
- Skipping or rejecting is reversible only in the backend you connect. The app keeps no undo.
- The reference backend has no multi-user support, rate limiting or TLS. Put it behind a proxy if you expose it.
- No camera or location is used. The microphone is used only while you are on the Listening screen.

## What existed before this repo

The hackathon build window started on 23 November 2026. Everything in this repository was written on or after that date, from an empty repo. No Dani source code from before that date is included or reused. Dependencies are listed in `package.json`. The sample data is synthetic.

## License

MIT. See `LICENSE`.
