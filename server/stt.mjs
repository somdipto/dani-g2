// Speech to text for voice replies, using Sarvam AI's REST endpoint (up to 30 seconds per clip).
// Docs: https://docs.sarvam.ai/api-reference/speech-to-text/transcribe
// The app uploads a WAV (16 kHz, mono, 16-bit), so the API detects the format by itself.

/**
 * @param {{ apiKey: string, model?: string, language?: string, endpoint?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {(wav: Buffer) => Promise<string>}
 */
export function createSarvamStt(opts) {
  const { apiKey, model = 'saaras:v4', language = 'unknown', endpoint = 'https://api.sarvam.ai/speech-to-text', fetchImpl = fetch, timeoutMs = 20_000 } = opts;
  if (!apiKey) throw new Error('Sarvam API key is required');
  return async (wav) => {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'reply.wav');
    form.append('model', model);
    form.append('language_code', language);
    if (model.startsWith('saaras')) form.append('mode', 'transcribe');
    let res;
    try {
      res = await fetchImpl(endpoint, { method: 'POST', headers: { 'api-subscription-key': apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`speech service unreachable: ${String(e instanceof Error ? e.message : e).split(apiKey).join('<key>')}`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`speech service returned HTTP ${res.status}`);
    const text = typeof j.transcript === 'string' ? j.transcript.trim() : '';
    if (!text) throw new Error('no speech recognised');
    return text;
  };
}
