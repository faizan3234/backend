import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../database/db.js';
import { calculateAdPrice, normalizeAdVenueIds, AD_VENUES } from '../services/adPricingService.js';
import { assertAdUploadAllowed, normalizeAdMedia } from '../services/adMediaService.js';
import adPaymentService from '../services/adPaymentService.js';

const DATA_ROOT = process.env.RELIV_AD_DATA_DIR || path.join(process.cwd(), 'data', 'ads');
const CURRENT_VENUE = process.env.RELIV_AD_CURRENT_VENUE || 'gurukul';
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 40;
const MAX_CONCURRENT = 8;

function db() { return getDb(); }
function campaignDir(id) { return path.join(DATA_ROOT, id); }
function isoDateInKolkata(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function addCalendarDays(dateStr, days) {
  const [y,m,d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0,10);
}
function parseMinute(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : fallback;
}
function id() {
  return `AD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function safeBaseName(name) {
  return path.basename(String(name || 'creative')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,120);
}
function mimeExt(mime) {
  return ({
    'image/jpeg':'.jpg',
    'image/png':'.png',
    'image/webp':'.webp',
    'video/mp4':'.mp4',
    'video/quicktime':'.mov'
  })[String(mime || '').toLowerCase()] || '';
}
function currentKolkataClock() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minute: Number(get('hour')) * 60 + Number(get('minute'))
  };
}
function assertScheduleAvailable({ venueIds, startDate, endDate, startMinute, endMinute, excludeCampaignId = '' }) {
  for (const venueId of venueIds) {
    for (let day = startDate; day <= endDate; day = addCalendarDays(day, 1)) {
      const row = db().prepare(`
        SELECT COUNT(*) AS count
        FROM ad_campaign_venues
        WHERE venue_id = ?
          AND status IN ('SCHEDULED','ACTIVE','PENDING_APPROVAL')
          AND campaign_id <> ?
          AND start_date <= ? AND end_date >= ?
          AND NOT (daily_end_minute <= ? OR daily_start_minute >= ?)
      `).get(venueId, excludeCampaignId, day, day, startMinute, endMinute);
      if (Number(row?.count || 0) >= MAX_CONCURRENT) {
        const err = new Error('This time window is fully booked. Choose another time.');
        err.code = 'AD_SLOT_FULL';
        throw err;
      }
    }
  }
}

async function cleanupAdStorage() {
  const now = Date.now();
  const expiredCutoff = now - 24 * 60 * 60 * 1000;
  const abandonedCutoff = now - 2 * 60 * 60 * 1000;
  const rows = db().prepare(`
    SELECT campaign_id,status,expired_at,created_at
    FROM ad_campaigns
    WHERE (status='EXPIRED' AND expired_at IS NOT NULL AND expired_at < ?)
       OR (status IN ('DRAFT','UPLOADING','PROCESSING','PENDING_PAYMENT') AND created_at < ?)
  `).all(expiredCutoff, abandonedCutoff);

  for (const row of rows) {
    try {
      await fs.promises.rm(campaignDir(row.campaign_id), { recursive:true, force:true });
    } catch {}
    db().prepare("UPDATE ad_campaigns SET original_path=NULL,prepared_path=NULL,updated_at=? WHERE campaign_id=?")
      .run(now,row.campaign_id);
    db().prepare("DELETE FROM ad_upload_chunks WHERE campaign_id=?").run(row.campaign_id);
    if (row.status !== 'EXPIRED') {
      db().prepare("UPDATE ad_campaigns SET status='CANCELLED',updated_at=? WHERE campaign_id=?")
        .run(now,row.campaign_id);
      db().prepare("UPDATE ad_payment_requests SET status='CANCELLED',cancelled_at=? WHERE campaign_id=? AND status='ACTIVE'")
        .run(now,row.campaign_id);
    }
  }
}
function serializeCampaign(row) {
  return {
    campaignId: row.campaign_id,
    mediaType: row.media_type,
    aspectRatio: row.aspect_ratio,
    isTrue16x9: row.is_true_16x9 === 1,
    hasAudio: row.has_audio === 1,
    durationSeconds: Number(row.duration_seconds || (row.media_type === 'video' ? 15 : 10)),
    mediaUrl: `/api/ads/media/${encodeURIComponent(row.campaign_id)}`,
    brandName: row.brand_name || ''
  };
}

export function createAdRouter() {
  const router = express.Router();

  router.get('/config', (_req, res) => {
    res.json({
      ok: true,
      currentVenueId: CURRENT_VENUE,
      display: { width: 1920, height: 1080, sizeInches: 11.6 },
      maxConcurrentCampaigns: MAX_CONCURRENT,
      venues: [
        { id:'gurukul', name:'Gurukul', isCurrent: CURRENT_VENUE === 'gurukul', requiresApproval:false },
        { id:'dps-megacity', name:'DPS Megacity School', isCurrent: CURRENT_VENUE === 'dps-megacity', requiresApproval:true },
        { id:'beeu-resorts', name:'Beeu Resorts', isCurrent: CURRENT_VENUE === 'beeu-resorts', requiresApproval:false }
      ],
      pricing: [
        { days:1, rupees:50, perDay:50 },
        { days:3, rupees:117, perDay:39, tag:'Most Popular' },
        { days:7, rupees:245, perDay:35 },
        { days:15, rupees:450, perDay:30 },
        { days:30, rupees:750, perDay:25 }
      ],
      allVenuesDiscountPercent: 20
    });
  });

  router.post('/quote', (req, res) => {
    try {
      const quote = calculateAdPrice({
        targetVenueIds: req.body?.targetVenueIds,
        durationDays: req.body?.durationDays
      });
      res.json({ ok:true, quote });
    } catch (err) {
      res.status(400).json({ ok:false, code:err.code || 'INVALID_QUOTE', message:err.message });
    }
  });

  router.post('/drafts', async (req, res) => {
    try {
      const targetVenueIds = normalizeAdVenueIds(req.body?.targetVenueIds || [CURRENT_VENUE]);
      const quote = calculateAdPrice({ targetVenueIds, durationDays:req.body?.durationDays });
      const today = isoDateInKolkata();
      const requestedStart = String(req.body?.startDate || today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStart) || requestedStart < today) {
        return res.status(400).json({ ok:false, code:'INVALID_START_DATE', message:'Choose today or a future start date.' });
      }

      const hasRemote = targetVenueIds.some(v => v !== CURRENT_VENUE);
      if (hasRemote && requestedStart <= today) {
        return res.status(400).json({
          ok:false, code:'REMOTE_VENUE_LEAD_TIME',
          message:'Remote venue campaigns must start from tomorrow so the offline venue can be prepared.'
        });
      }

      const isAllDay = req.body?.isAllDay !== false;
      const dailyStartMinute = isAllDay ? 0 : parseMinute(req.body?.dailyStartMinute, 600);
      const dailyEndMinute = isAllDay ? 1440 : parseMinute(req.body?.dailyEndMinute, 1080);
      if (dailyEndMinute <= dailyStartMinute) {
        return res.status(400).json({ ok:false, code:'INVALID_HOURS', message:'End time must be after start time.' });
      }
      const endDate = addCalendarDays(requestedStart, quote.durationDays - 1);
      assertScheduleAvailable({
        venueIds:targetVenueIds, startDate:requestedStart, endDate,
        startMinute:dailyStartMinute, endMinute:dailyEndMinute
      });

      const campaignId = id();
      const now = Date.now();
      const tx = db().transaction(() => {
        db().prepare(`
          INSERT INTO ad_campaigns (
            campaign_id,kiosk_id,price_paise,pricing_version,duration_days,status,created_at,updated_at
          ) VALUES (?,?,?,?,?,'DRAFT',?,?)
        `).run(campaignId, process.env.PAYMENT_V2_KIOSK_ID || process.env.KIOSK_ID || 'RELIV-001',
          quote.pricePaise, quote.pricingVersion, quote.durationDays, now, now);

        const stmt = db().prepare(`
          INSERT INTO ad_campaign_venues (
            campaign_id,venue_id,status,start_date,end_date,is_all_day,daily_start_minute,daily_end_minute
          ) VALUES (?,?,?, ?,?,?,?,?)
        `);
        for (const venueId of targetVenueIds) {
          const status = venueId === 'dps-megacity' ? 'PENDING_APPROVAL' : 'SCHEDULED';
          stmt.run(campaignId, venueId, status, requestedStart, endDate, isAllDay ? 1 : 0, dailyStartMinute, dailyEndMinute);
        }
      });
      tx();
      await fs.promises.mkdir(path.join(campaignDir(campaignId), 'chunks'), { recursive:true });

      res.json({ ok:true, campaignId, quote, schedule:{
        startDate:requestedStart,endDate,isAllDay,dailyStartMinute,dailyEndMinute,targetVenueIds
      }});
    } catch (err) {
      res.status(err.code === 'AD_SLOT_FULL' ? 409 : 400).json({ ok:false, code:err.code || 'CREATE_DRAFT_FAILED', message:err.message });
    }
  });

  router.post('/:campaignId/chunks',
    express.raw({ type:'application/octet-stream', limit:'5mb' }),
    async (req, res) => {
      try {
        const campaignId = String(req.params.campaignId);
        const campaign = db().prepare('SELECT * FROM ad_campaigns WHERE campaign_id=?').get(campaignId);
        if (!campaign || !['DRAFT','UPLOADING'].includes(campaign.status)) {
          return res.status(409).json({ ok:false, code:'INVALID_CAMPAIGN_STATE', message:'Campaign cannot accept uploads.' });
        }
        const index = Number(req.query.index);
        const total = Number(req.query.total);
        const mimeType = String(req.query.mime || '');
        const totalSize = Number(req.query.size || 0);
        assertAdUploadAllowed({ mimeType, size:totalSize });
        if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || index >= total) {
          return res.status(400).json({ ok:false, code:'INVALID_CHUNK', message:'Invalid upload chunk.' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > CHUNK_BYTES + 1024) {
          return res.status(400).json({ ok:false, code:'INVALID_CHUNK_SIZE', message:'Invalid upload chunk size.' });
        }
        const chunksDir = path.join(campaignDir(campaignId), 'chunks');
        await fs.promises.mkdir(chunksDir, { recursive:true });
        const chunkPath = path.join(chunksDir, String(index).padStart(4,'0') + '.part');
        await fs.promises.writeFile(chunkPath, req.body);
        const sha = crypto.createHash('sha256').update(req.body).digest('hex');
        db().prepare(`
          INSERT INTO ad_upload_chunks (campaign_id,upload_id,chunk_index,total_chunks,chunk_path,chunk_sha256,received_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(upload_id,chunk_index) DO UPDATE SET
            chunk_path=excluded.chunk_path,chunk_sha256=excluded.chunk_sha256,received_at=excluded.received_at
        `).run(campaignId,campaignId,index,total,chunkPath,sha,Date.now());
        db().prepare("UPDATE ad_campaigns SET status='UPLOADING', mime_type=?, updated_at=? WHERE campaign_id=?")
          .run(mimeType,Date.now(),campaignId);
        res.json({ ok:true,index,total,receivedBytes:req.body.length });
      } catch (err) {
        res.status(400).json({ ok:false, code:err.code || 'UPLOAD_FAILED', message:err.message });
      }
    }
  );

  router.post('/:campaignId/finalize', async (req, res) => {
    const campaignId = String(req.params.campaignId);
    try {
      const campaign = db().prepare('SELECT * FROM ad_campaigns WHERE campaign_id=?').get(campaignId);
      if (!campaign || !['DRAFT','UPLOADING'].includes(campaign.status)) {
        return res.status(409).json({ ok:false, code:'INVALID_CAMPAIGN_STATE', message:'Campaign cannot be finalized.' });
      }
      const mimeType = String(req.body?.mimeType || campaign.mime_type || '');
      const totalSize = Number(req.body?.size || 0);
      const { mediaType } = assertAdUploadAllowed({ mimeType, size:totalSize });
      const chunks = db().prepare(`
        SELECT * FROM ad_upload_chunks WHERE campaign_id=? ORDER BY chunk_index
      `).all(campaignId);
      if (!chunks.length || chunks.length !== chunks[0].total_chunks ||
          chunks.some((c,i) => c.chunk_index !== i || c.total_chunks !== chunks.length)) {
        return res.status(409).json({ ok:false, code:'UPLOAD_INCOMPLETE', message:'Upload is incomplete. Please resume the upload.' });
      }

      const dir = campaignDir(campaignId);
      const ext = mimeExt(mimeType);
      const originalPath = path.join(dir, 'original' + ext);
      const fh = await fs.promises.open(originalPath, 'w');
      try {
        for (const chunk of chunks) {
          const data = await fs.promises.readFile(chunk.chunk_path);
          await fh.write(data);
        }
      } finally {
        await fh.close();
      }
      if (fs.statSync(originalPath).size !== totalSize) {
        throw Object.assign(new Error('Uploaded file size does not match the original.'), { code:'UPLOAD_SIZE_MISMATCH' });
      }

      db().prepare("UPDATE ad_campaigns SET status='PROCESSING',original_name=?,mime_type=?,original_path=?,updated_at=? WHERE campaign_id=?")
        .run(safeBaseName(req.body?.originalName),mimeType,originalPath,Date.now(),campaignId);

      const normalized = await normalizeAdMedia({ inputPath:originalPath, outputDir:dir, mimeType });
      db().prepare(`
        UPDATE ad_campaigns SET
          media_type=?,aspect_ratio=?,is_true_16x9=?,has_audio=?,prepared_path=?,media_sha256=?,
          duration_seconds=?,status='PENDING_PAYMENT',updated_at=?
        WHERE campaign_id=?
      `).run(
        mediaType,normalized.aspectRatio,normalized.isTrue16x9 ? 1 : 0,normalized.hasAudio ? 1 : 0,
        normalized.outputPath,normalized.mediaSHA256,normalized.durationSeconds,Date.now(),campaignId
      );

      res.json({
        ok:true,campaignId,
        media:{
          mediaType,aspectRatio:normalized.aspectRatio,isTrue16x9:normalized.isTrue16x9,
          hasAudio:normalized.hasAudio,durationSeconds:normalized.durationSeconds,
          width:normalized.preparedWidth,height:normalized.preparedHeight,
          previewUrl:`/api/ads/media/${encodeURIComponent(campaignId)}`
        }
      });
    } catch (err) {
      db().prepare("UPDATE ad_campaigns SET status='DRAFT',updated_at=? WHERE campaign_id=?").run(Date.now(),campaignId);
      res.status(400).json({ ok:false, code:err.code || 'FINALIZE_FAILED', message:err.message });
    }
  });

  router.post('/:campaignId/confirm-booking', (req, res) => {
    try {
      const campaignId = String(req.params.campaignId);
      const campaign = db().prepare('SELECT * FROM ad_campaigns WHERE campaign_id=?').get(campaignId);
      if (!campaign || campaign.status !== 'PENDING_PAYMENT') {
        return res.status(409).json({ ok:false, code:'AD_NOT_READY', message:'Prepare the creative before payment.' });
      }
      const assignments = db().prepare('SELECT * FROM ad_campaign_venues WHERE campaign_id=?').all(campaignId);
      assertScheduleAvailable({
        venueIds:assignments.map(v=>v.venue_id),
        startDate:assignments[0].start_date,endDate:assignments[0].end_date,
        startMinute:assignments[0].daily_start_minute,endMinute:assignments[0].daily_end_minute,
        excludeCampaignId:campaignId
      });
      const payment = adPaymentService.createPaymentRequest(campaignId);
      res.json({ ok:true, campaignId, requestId:payment.requestId, expiresAt:payment.expiresAt });
    } catch (err) {
      res.status(err.code === 'AD_SLOT_FULL' ? 409 : 400).json({ ok:false, code:err.code || 'PAYMENT_PREP_FAILED', message:err.message });
    }
  });

  router.get('/pending-payment', (_req, res) => {
    adPaymentService.expireStaleRequests();
    const row = db().prepare(`
      SELECT r.request_id,r.campaign_id,r.amount,r.encrypted_package,r.expires_at,
             c.duration_days,
             group_concat(v.venue_id) AS venue_ids
      FROM ad_payment_requests r
      JOIN ad_campaigns c ON c.campaign_id=r.campaign_id
      JOIN ad_campaign_venues v ON v.campaign_id=c.campaign_id
      WHERE r.status='ACTIVE' AND r.expires_at>?
      GROUP BY r.request_id
      ORDER BY r.created_at DESC LIMIT 1
    `).get(Date.now());
    if (!row) return res.json({ ok:true, pending:null });
    res.json({
      ok:true,
      pending:{
        requestId:row.request_id,campaignId:row.campaign_id,
        amountPaise:row.amount,durationDays:row.duration_days,
        venueIds:String(row.venue_ids || '').split(',').filter(Boolean),
        expiresAt:row.expires_at,
        paymentUrl:`https://reliv7.vercel.app/pay#p=${row.encrypted_package}`
      }
    });
  });

  router.post('/:campaignId/activate', (req, res) => {
    const result = adPaymentService.verifyCode({
      campaignId:String(req.params.campaignId),
      requestId:String(req.body?.requestId || ''),
      code:String(req.body?.code || '')
    });
    res.status(result.ok ? 200 : (result.code === 'LOCKED' ? 423 : 400)).json(result);
  });

  router.get('/active-playlist', async (_req, res) => {
    await cleanupAdStorage();
    const now = currentKolkataClock();
    db().prepare(`
      UPDATE ad_campaign_venues SET status='EXPIRED'
      WHERE end_date < ? AND status IN ('ACTIVE','SCHEDULED')
    `).run(now.date);
    db().prepare(`
      UPDATE ad_campaigns SET status='EXPIRED',expired_at=COALESCE(expired_at,?),updated_at=?
      WHERE campaign_id IN (
        SELECT c.campaign_id FROM ad_campaigns c
        WHERE c.status IN ('ACTIVE','SCHEDULED')
          AND NOT EXISTS (
            SELECT 1 FROM ad_campaign_venues v
            WHERE v.campaign_id=c.campaign_id AND v.status IN ('ACTIVE','SCHEDULED','PENDING_APPROVAL')
          )
      )
    `).run(Date.now(),Date.now());

    const rows = db().prepare(`
      SELECT c.*,v.start_date,v.end_date,v.is_all_day,v.daily_start_minute,v.daily_end_minute
      FROM ad_campaigns c
      JOIN ad_campaign_venues v ON v.campaign_id=c.campaign_id
      WHERE v.venue_id=?
        AND c.status IN ('ACTIVE','SCHEDULED')
        AND v.status IN ('ACTIVE','SCHEDULED')
        AND v.start_date<=? AND v.end_date>=?
        AND (v.is_all_day=1 OR (? >= v.daily_start_minute AND ? < v.daily_end_minute))
        AND c.prepared_path IS NOT NULL
      ORDER BY c.activated_at ASC,c.created_at ASC
      LIMIT ?
    `).all(CURRENT_VENUE,now.date,now.date,now.minute,now.minute,MAX_CONCURRENT);

    for (const row of rows) {
      if (row.status === 'SCHEDULED') {
        db().prepare("UPDATE ad_campaigns SET status='ACTIVE',updated_at=? WHERE campaign_id=?")
          .run(Date.now(),row.campaign_id);
      }
      db().prepare("UPDATE ad_campaign_venues SET status='ACTIVE' WHERE campaign_id=? AND venue_id=? AND status='SCHEDULED'")
        .run(row.campaign_id,CURRENT_VENUE);
    }
    res.json({ ok:true, venueId:CURRENT_VENUE, ads:rows.map(serializeCampaign) });
  });

  router.get('/media/:campaignId', (req, res) => {
    const row = db().prepare('SELECT prepared_path,media_type FROM ad_campaigns WHERE campaign_id=?').get(String(req.params.campaignId));
    if (!row?.prepared_path || !fs.existsSync(row.prepared_path)) return res.sendStatus(404);
    res.type(row.media_type === 'video' ? 'video/mp4' : 'image/webp');
    res.set('Cache-Control','no-store');
    res.sendFile(path.resolve(row.prepared_path));
  });

  router.post('/:campaignId/play-event', (req, res) => {
    const campaignId = String(req.params.campaignId);
    const exists = db().prepare('SELECT 1 FROM ad_campaigns WHERE campaign_id=?').get(campaignId);
    if (!exists) return res.sendStatus(404);
    db().prepare(`
      INSERT INTO ad_play_events(campaign_id,venue_id,started_at,completed,interrupted_by_user)
      VALUES(?,?,?,?,?)
    `).run(campaignId,CURRENT_VENUE,Number(req.body?.startedAt || Date.now()),req.body?.completed ? 1 : 0,req.body?.interruptedByUser ? 1 : 0);
    res.json({ ok:true });
  });

  return router;
}

export default createAdRouter;
