import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeAdMedia } from './src/services/adMediaService.js';

test('real FFmpeg prepares portrait image and video with/without audio', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'reliv-media-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for (const [name,mime,audio] of [['poster.png','image/png',false],['silent.mp4','video/mp4',false],['audio.mp4','video/mp4',true]]) {
    const inputPath = path.join(dir,name);
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=orange:s=240x320:r=12',
      ...(audio ? ['-f','lavfi','-i','sine=frequency=440:sample_rate=44100'] : []),
      ...(mime.startsWith('image') ? ['-frames:v','1','-threads','1'] : ['-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p', ...(audio ? ['-c:a','aac'] : ['-an'])]), inputPath],{timeout:20000});
    const result = await normalizeAdMedia({inputPath,outputDir:path.join(dir,name+'-output'),mimeType:mime});
    assert.equal(result.preparedWidth,1920); assert.equal(result.preparedHeight,1080);
    assert.equal(result.hasAudio,audio); assert.equal(result.aspectRatio,'portrait');
    assert.match(result.mediaSHA256,/^[a-f0-9]{64}$/); assert.ok(fs.statSync(result.outputPath).size > 0);
  }
});
