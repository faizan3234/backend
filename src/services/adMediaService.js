import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';

const WIDTH = 1920;
const HEIGHT = 1080;
const MAX_VIDEO_SECONDS = 15;
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg','image/png','image/webp']);
const ALLOWED_VIDEO_MIME = new Set(['video/mp4','video/quicktime']);
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore','pipe','pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Media processing timed out. Please use a smaller file.')); }, 120000);
    child.stdout.on('data', d => { out = (out + d.toString()).slice(-1048576); });
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${bin} failed: ${err}`)); });
  });
}

export function assertAdUploadAllowed({ mimeType, size }) {
  const mime = String(mimeType || '').toLowerCase();
  const bytes = Number(size || 0);
  const isImage = ALLOWED_IMAGE_MIME.has(mime);
  const isVideo = ALLOWED_VIDEO_MIME.has(mime);
  if (!isImage && !isVideo) {
    const err = new Error('Unsupported file. Use JPG, PNG, WebP, MP4 or MOV.');
    err.code = 'UNSUPPORTED_AD_MEDIA';
    throw err;
  }
  const max = isVideo ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > max) {
    const err = new Error(isVideo ? 'Video must be 150 MB or smaller.' : 'Image must be 20 MB or smaller.');
    err.code = 'AD_MEDIA_TOO_LARGE';
    throw err;
  }
  return { mediaType: isVideo ? 'video' : 'image', maxBytes: max };
}

export async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function probeMedia(filePath) {
  const raw = await run('ffprobe', [
    '-v','error',
    '-print_format','json',
    '-show_streams',
    '-show_format',
    '-protocol_whitelist','file,pipe',
    filePath
  ]);
  const info = JSON.parse(raw);
  const video = (info.streams || []).find(s => s.codec_type === 'video');
  if (!video || !video.width || !video.height) {
    const err = new Error('Media does not contain a readable image/video stream.');
    err.code = 'INVALID_AD_MEDIA';
    throw err;
  }
  const audio = (info.streams || []).some(s => s.codec_type === 'audio');
  const duration = Number(info.format?.duration || video.duration || 0);
  const ratio = Number(video.width) / Number(video.height);
  let category = 'square';
  if (ratio >= 1.74 && ratio <= 1.81) category = '16:9';
  else if (ratio > 1.05) category = 'landscape';
  else if (ratio < 0.85) category = 'portrait';

  return {
    width: Number(video.width),
    height: Number(video.height),
    ratio,
    category,
    isTrue16x9: category === '16:9',
    hasAudio: audio,
    durationSeconds: Number.isFinite(duration) ? duration : 0
  };
}

function normalizedFilter(meta) {
  if (meta.isTrue16x9) {
    return `[0:v]scale=${WIDTH}:${HEIGHT}:flags=lanczos[outv]`;
  }
  return [
    '[0:v]split=2[bg][fg]',
    `[bg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},gblur=sigma=40,eq=brightness=0.08:saturation=0.85[bg2]`,
    `[fg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg2]`,
    '[bg2][fg2]overlay=(W-w)/2:(H-h)/2[outv]'
  ].join(';');
}

let processing = false;
export async function normalizeAdMedia(options) {
  if (processing) throw new Error('Another creative is being prepared. Please retry shortly.');
  processing = true;
  try { return await prepareMedia(options); }
  finally { processing = false; }
}

async function prepareMedia({ inputPath, outputDir, mimeType }) {
  const { mediaType } = assertAdUploadAllowed({ mimeType, size: fs.statSync(inputPath).size });
  const meta = await probeMedia(inputPath);
  if (meta.width > 8192 || meta.height > 8192 || meta.width * meta.height > 33554432) throw new Error('Media resolution is too large. Export at 1920 × 1080 and retry.');
  await fs.promises.mkdir(outputDir, { recursive: true });

  if (mediaType === 'video' && meta.durationSeconds > 60 * 10) {
    const err = new Error('Video is too long to process.');
    err.code = 'AD_VIDEO_TOO_LONG';
    throw err;
  }

  const outputPath = path.join(outputDir, mediaType === 'video' ? 'prepared.mp4' : 'prepared.webp');
  const vf = normalizedFilter(meta);

  if (mediaType === 'video') {
    const args = [
      '-y','-threads','2','-filter_complex_threads','1','-protocol_whitelist','file,pipe','-i',inputPath,
      '-t',String(MAX_VIDEO_SECONDS),
      '-filter_complex',vf,
      '-map','[outv]',
      ...(meta.hasAudio ? ['-map','0:a:0','-c:a','aac','-b:a','128k','-af','loudnorm=I=-24:LRA=7:TP=-2'] : ['-an']),
      '-c:v','libx264',
      '-threads','2',
      '-pix_fmt','yuv420p',
      '-preset','fast',
      '-crf','23',
      '-r','30',
      '-movflags','+faststart',
      outputPath
    ];
    await run('ffmpeg', args);
  } else {
    await run('ffmpeg', [
      '-y','-threads','2','-filter_complex_threads','1','-protocol_whitelist','file,pipe','-i',inputPath,
      '-filter_complex',vf,
      '-map','[outv]',
      '-frames:v','1',
      '-c:v','libwebp',
      '-quality','90',
      outputPath
    ]);
  }

  const preparedMeta = await probeMedia(outputPath);
  const mediaSHA256 = await sha256File(outputPath);

  return {
    outputPath,
    mediaSHA256,
    mediaType,
    aspectRatio: meta.category,
    isTrue16x9: meta.isTrue16x9,
    hasAudio: mediaType === 'video' && meta.hasAudio,
    originalWidth: meta.width,
    originalHeight: meta.height,
    durationSeconds: mediaType === 'video'
      ? Math.min(MAX_VIDEO_SECONDS, meta.durationSeconds || MAX_VIDEO_SECONDS)
      : 10,
    preparedWidth: preparedMeta.width,
    preparedHeight: preparedMeta.height
  };
}
