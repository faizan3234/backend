import { spawn } from 'node:child_process';

// Produce WAV in memory on the Pi. No shell, cloud API, persisted report text,
// or server-side speaker playback (the browser owns cancellation/audio focus).
export function createLocalSpeechHandler({ spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  let active = 0;
  return (req, res) => {
    const { text, language } = req.body || {};
    const voices = { en: 'en', hi: 'hi', bn: 'bn' };
    res.set('Cache-Control', 'private, no-store');
    if (typeof text !== 'string' || !text.trim() || text.length > 1600 || !Object.hasOwn(voices, language)) {
      return res.status(400).json({ ok: false, error: 'Use en, hi or bn and 1–1600 characters.' });
    }
    if (active >= 2) return res.status(429).json({ ok: false, error: 'Speaker preparation is busy. Try again.' });
    active++;
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const finish = (status, payload) => {
      if (settled) return;
      settled = true; active--; clearTimeout(timer);
      res.off('close', disconnected);
      if (status !== 200) child?.kill('SIGKILL');
      if (res.destroyed) return;
      if (status === 200) res.type('audio/wav').send(payload);
      else res.status(status).json({ ok: false, error: payload });
    };
    const disconnected = () => finish(499, 'Request cancelled.');
    res.on('close', disconnected);
    try {
      child = spawnProcess('espeak-ng', ['--stdout', '--stdin', '-v', voices[language], '-s', '145'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      child.on('error', () => finish(503, 'Offline speech is unavailable. Install espeak-ng on the Pi.'));
      child.stdin.on('error', () => finish(503, 'Offline speech input failed.'));
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) finish(503, 'Speech response is too large.');
        else chunks.push(chunk);
      });
      child.on('close', code => {
        if (settled) return;
        const audio = Buffer.concat(chunks);
        if (code !== 0 || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') finish(503, 'Offline speech could not be prepared.');
        else finish(200, audio);
      });
      timer = setTimeout(() => finish(504, 'Offline speech preparation timed out.'), timeoutMs);
      child.stdin.end(text.trim(), 'utf8');
    } catch { finish(503, 'Offline speech could not start.'); }
  };
}
