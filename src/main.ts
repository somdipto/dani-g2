import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { HttpExecutor, HttpSource, SampleSource, SimulatedExecutor } from './adapters';
import { Controller } from './controller';
import { GlassesView, toInput } from './glasses';
import { DemoMic, GlassesMic } from './mic';

const logEl = document.getElementById('log');
const log = (m: string) => {
  console.log(`[dani-g2] ${m}`);
  if (logEl) logEl.textContent += `${m}\n`;
};

async function boot() {
  const params = new URLSearchParams(location.search);
  const backend = params.get('backend')?.replace(/\/+$/, ''); // ?backend=http://host:8787&token=...
  const token = params.get('token') ?? undefined;
  const demo = params.get('demo') === '1';
  const source = backend ? new HttpSource(backend, token) : demo ? new SampleSource() : undefined;
  const executor = backend ? new HttpExecutor(backend, token) : new SimulatedExecutor(900, ['s-3']);
  log(backend ? `backend: ${backend}` : demo ? 'demo mode: made-up SAMPLE items, simulated executor' : 'no backend set');

  const bridge = await waitForEvenAppBridge();
  const view = new GlassesView(bridge);
  const app = new Controller(
    source,
    executor,
    { get: (k) => bridge.getLocalStorage(k), set: (k, v) => bridge.setLocalStorage(k, v) },
    (p) => view.show(p),
    log,
    demo && !backend ? new DemoMic() : new GlassesMic(bridge),
  );
  bridge.onEvenHubEvent((event) => {
    const input = toInput(event);
    if (input) void app.handle(input).catch((e) => log(`error: ${e instanceof Error ? e.message : e}`));
  });
  await app.start();
  log('ready');
}

boot().catch((e) => log(`boot failed: ${e instanceof Error ? e.message : e}`));
