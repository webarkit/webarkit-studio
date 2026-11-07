/**
 * A short beep written from scratch, so it is our own: 0.2 s of 880 Hz, 8 kHz, mono, 16 bits, faded at
 * both ends so that it does not click. It is the action.playSound default (public/sounds/beep.wav,
 * checked against this by tests/unit/actions.test.ts). Regenerate the file with:
 *
 *   npx tsx -e "import('./tests/helpers/beep-wav.ts').then(m => require('node:fs').writeFileSync('public/sounds/beep.wav', m.beepWav()))"
 */
export function beepWav(): Uint8Array {
  const rate = 8000;
  const samples = rate / 5;
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, out.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 80, (samples - 1 - i) / 80);
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 880 * i) / rate) * fade * 16000), true);
  }
  return out;
}
