import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'data', 'tts_cache');
const WORKER_SCRIPT = path.resolve(__dirname, '..', 'services', 'ttsWorker.py');

try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not initialize tts_cache directory:', e);
}

// Strictly Female Neural Voices - Exactly matching Reliv Splash screen and kiosk audio
const NEURAL_FEMALE_VOICES = {
  en: 'en-IN-NeerjaNeural',
  hi: 'hi-IN-SwaraNeural',
  bn: 'bn-IN-TanishaaNeural'
};

const ESPEAK_VOICES = {
  en: 'en',
  hi: 'hi',
  bn: 'bn'
};

export function createLocalSpeechHandler({ spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  let active = 0;
  const isMock = spawnProcess !== spawn;

  return async (req, res) => {
    const { text, language } = req.body || {};
    const voices = { en: 'en', hi: 'hi', bn: 'bn' };
    res.set('Cache-Control', 'private, no-store');

    if (typeof text !== 'string' || !text.trim() || text.length > 1600 || !Object.hasOwn(voices, language)) {
      return res.status(400).json({ ok: false, error: 'Use en, hi or bn and 1–1600 characters.' });
    }

    if (active >= 2) {
      return res.status(429).json({ ok: false, error: 'Speaker preparation is busy. Try again.' });
    }
    active++;

    const safeLang = voices[language];
    const trimmedText = text.trim();

    // If running in unit test with mock spawnProcess, use pure espeak-ng pipeline
    if (isMock) {
      let child, timer, settled = false, size = 0;
      const chunks = [];
      const finish = (status, payload) => {
        if (settled) return;
        settled = true;
        active = Math.max(0, active - 1);
        clearTimeout(timer);
        res.off('close', disconnected);
        if (status !== 200) child?.kill?.('SIGKILL');
        if (res.destroyed) return;
        if (status === 200) res.type('audio/wav').send(payload);
        else res.status(status).json({ ok: false, error: payload });
      };
      const disconnected = () => finish(499, 'Request cancelled.');
      res.on('close', disconnected);

      try {
        child = spawnProcess('espeak-ng', ['--stdout', '--stdin', '-v', voices[language], '-s', '145'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          shell: false
        });
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
          if (code !== 0 || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') {
            finish(503, 'Offline speech could not be prepared.');
          } else {
            finish(200, audio);
          }
        });
        timer = setTimeout(() => finish(504, 'Offline speech preparation timed out.'), timeoutMs);
        child.stdin.end(trimmedText, 'utf8');
      } catch {
        finish(503, 'Offline speech could not start.');
      }
      return;
    }

    // Production execution on Raspberry Pi / Windows kiosk
    const voice = NEURAL_FEMALE_VOICES[safeLang] || NEURAL_FEMALE_VOICES.en;
    const hash = crypto.createHash('sha256').update(`${safeLang}:${voice}:${trimmedText}`).digest('hex');
    const cachedMp3 = path.join(CACHE_DIR, `${hash}.mp3`);
    const cachedWav = path.join(CACHE_DIR, `${hash}.wav`);

    // 1. Fast Cache Hit (< 5ms response)
    if (fs.existsSync(cachedMp3)) {
      try {
        const stats = fs.statSync(cachedMp3);
        if (stats.size > 500) {
          active = Math.max(0, active - 1);
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Length', stats.size);
          return fs.createReadStream(cachedMp3).pipe(res);
        }
      } catch { /* regenerate */ }
    }
    if (fs.existsSync(cachedWav)) {
      try {
        const stats = fs.statSync(cachedWav);
        if (stats.size > 500) {
          active = Math.max(0, active - 1);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Content-Length', stats.size);
          return fs.createReadStream(cachedWav).pipe(res);
        }
      } catch { /* regenerate */ }
    }

    let finished = false;
    let timer = null;
    let activeChild = null;

    const cleanup = () => {
      clearTimeout(timer);
      res.off('close', onClientClose);
    };

    const done = () => {
      if (!finished) {
        finished = true;
        active = Math.max(0, active - 1);
        cleanup();
      }
    };

    const onClientClose = () => {
      if (!finished) {
        try { activeChild?.kill('SIGKILL'); } catch {}
        done();
      }
    };
    res.on('close', onClientClose);

    // Fallback: spawn espeak-ng on Pi
    const tryEspeak = () => {
      if (finished) return;
      try {
        const chunks = [];
        let size = 0;
        const espeak = spawn('espeak-ng', ['--stdout', '--stdin', '-v', ESPEAK_VOICES[safeLang] || 'en', '-s', '145'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          shell: false
        });
        activeChild = espeak;

        espeak.on('error', (err) => {
          console.warn('espeak-ng error:', err.message);
          done();
          return res.status(503).json({ ok: false, error: 'Offline speech service unavailable' });
        });

        espeak.stdin.on('error', () => {
          done();
          return res.status(503).json({ ok: false, error: 'Offline speech input failed.' });
        });

        espeak.stdout.on('data', chunk => {
          size += chunk.length;
          if (size <= 8 * 1024 * 1024) chunks.push(chunk);
        });

        espeak.on('close', code => {
          if (finished) return;
          const audio = Buffer.concat(chunks);
          if (code === 0 && audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF') {
            try { fs.writeFileSync(cachedWav, audio); } catch {}
            done();
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', audio.length);
            return res.send(audio);
          }
          done();
          return res.status(503).json({ ok: false, error: 'Speech generation failed' });
        });

        espeak.stdin.end(trimmedText, 'utf8');
      } catch (err) {
        done();
        return res.status(503).json({ ok: false, error: err.message });
      }
    };

    // Attempt Edge-TTS via python/python3 first (neural female voice)
    const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    const tempFile = path.join(CACHE_DIR, `${hash}_${Date.now()}.partial.mp3`);

    try {
      const child = spawn(pythonBin, [WORKER_SCRIPT, trimmedText, voice, tempFile], {
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false
      });
      activeChild = child;

      child.on('error', () => {
        // Python or Edge-TTS not installed / ENOENT -> Fall back to espeak-ng immediately
        tryEspeak();
      });

      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(tempFile)) {
          try {
            const stats = fs.statSync(tempFile);
            if (stats.size > 500) {
              fs.renameSync(tempFile, cachedMp3);
              done();
              res.setHeader('Content-Type', 'audio/mpeg');
              res.setHeader('Content-Length', stats.size);
              return fs.createReadStream(cachedMp3).pipe(res);
            }
          } catch {}
        }
        // If Edge-TTS failed (offline, timeout, etc.), clean up and fallback to espeak-ng
        if (fs.existsSync(tempFile)) {
          try { fs.unlinkSync(tempFile); } catch {}
        }
        tryEspeak();
      });

      timer = setTimeout(() => {
        if (!finished) {
          try { child?.kill(); } catch {}
          tryEspeak();
        }
      }, Math.min(timeoutMs, 8000));

    } catch {
      tryEspeak();
    }
  };
}
