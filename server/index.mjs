// Usage: node server/index.mjs        (settings come from the environment or a .env file, see .env.example)
import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createDrafter } from './drafter.mjs';
import { createSarvamStt } from './stt.mjs';
import { createTelegramBridge, parseChats } from './telegram.mjs';

if (existsSync(new URL('../.env', import.meta.url))) process.loadEnvFile(new URL('../.env', import.meta.url));
const env = process.env;
const log = (m) => console.log(`[dani-g2] ${m}`);

const port = Number(env.PORT ?? 8787);
const token = env.DANI_TOKEN;
const host = env.HOST ?? (token ? '0.0.0.0' : '127.0.0.1');
const handlerUrl = env.DANI_HANDLER_URL;
const file = env.DANI_DATA ?? new URL('./data.json', import.meta.url).pathname;

const stt = env.SARVAM_API_KEY
  ? createSarvamStt({ apiKey: env.SARVAM_API_KEY, model: env.SARVAM_MODEL || undefined, language: env.SARVAM_LANGUAGE || undefined })
  : undefined;

let bridge;
const handlers = {};
let app;
if (env.TELEGRAM_BOT_TOKEN) {
  const chats = parseChats(env.TELEGRAM_CHAT_IDS);
  if (!chats.size) log('TELEGRAM_CHAT_IDS is empty: the bot will ignore every chat. Add ids or @usernames.');
  const drafter = createDrafter({ apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL || undefined, model: env.LLM_MODEL || undefined, log });
  app = createApp({ file, token, handlerUrl, stt, handlers });
  bridge = createTelegramBridge({ token: env.TELEGRAM_BOT_TOKEN, chats, drafter, enqueue: app.enqueue, log });
  handlers.telegram = bridge.handle;
} else {
  app = createApp({ file, token, handlerUrl, stt, handlers });
}

app.listen(port, host, () => {
  log(`backend on http://${host}:${port}`);
  if (!token) log('DANI_TOKEN is not set: listening on localhost only, no auth.');
  log(handlerUrl ? `approve -> POST ${handlerUrl} (for items without their own handler)` : 'DANI_HANDLER_URL is not set: approve on non-Telegram items only records the decision.');
  log(bridge ? 'Telegram: on (replies send only after approval)' : 'Telegram: off (set TELEGRAM_BOT_TOKEN)');
  log(stt ? 'Voice replies: on (Sarvam)' : 'Voice replies: off (set SARVAM_API_KEY)');
  bridge?.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bridge?.stop(); process.exit(0); });
