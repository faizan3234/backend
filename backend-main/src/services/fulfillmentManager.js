import { getDb } from '../database/db.js';
import crypto from 'crypto';

/**
 * Fulfillment State Machine
 * 
 * Manages the complete dispensing lifecycle with:
 * - Idempotent fulfillment (prevent double-dispense)
 * - State tracking (PENDING → IN_PROGRESS → COMPLETED / FAILED / MANUAL_REVIEW_REQUIRED)
 * - Restart recovery (Pi can crash and recover safely)
 * - Retry logic (max 3 attempts for PENDING jobs only)
 * - MQTT integration (local Mosquitto → ESP32)
 * 
 * CRITICAL: This prevents the double-dispense attack where:
 * - Payment verified
 * - Dispense starts
 * - Pi crashes
 * - Pi restarts
 * - Duplicate dispense would lose money
 * 
 * State Transitions:
 *   PENDING → IN_PROGRESS → COMPLETED ✅
 *           → IN_PROGRESS → FAILED ❌ (after max attempts from PENDING)
 *           → IN_PROGRESS (at restart) → MANUAL_REVIEW_REQUIRED ⚠️
 *
 * SAFETY RULE: IN_PROGRESS jobs are NEVER automatically retried.
 * After a Pi restart, IN_PROGRESS → MANUAL_REVIEW_REQUIRED.
 * Only PENDING jobs may be published to MQTT.
 */

class FulfillmentManager {
  constructor() {
    this.db = getDb();
    
    // MQTT will be injected by server.js
    this.mqttClient = null;
  }

  /**
   * Set MQTT client for dispensing commands
   */
  setMqttClient(client) {
    this.mqttClient = client;
    console.log('✅ Fulfillment Manager: MQTT client configured');
  }

  /**
   * Generate unique job ID
   */
  generateJobId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `JOB-${timestamp}-${random}`;
  }

  /**
   * Create fulfillment job after payment verified
   * 
   * IDEMPOTENCY: If job already exists for transaction, returns existing job
   * 
   * @param {string} sessionId - Session ID
   * @param {string} transactionId - Transaction ID
   * @param {string} kitId - Kit to dispense
   * @param {number} quantity - Quantity (usually 1)
   * @returns {Promise<object>} - Created or existing job
   */
  async createJob(sessionId, transactionId, kitId, quantity = 1) {
    // Check if fulfillment already exists (idempotency)
    const existing = this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE transaction_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(transactionId);

    if (existing) {
      console.log(`⚠️ Fulfillment job already exists for transaction ${transactionId}`);
      console.log(`   State: ${existing.state}, Job ID: ${existing.job_id}`);
      
      // If already COMPLETED, prevent duplicate
      if (existing.state === 'COMPLETED') {
        console.log(`   ✅ Already dispensed - preventing double-dispense`);
        return existing;
      }
      
      // If FAILED with max attempts, prevent retry
      if (existing.state === 'FAILED' && existing.attempts >= existing.max_attempts) {
        console.log(`   ❌ Failed after ${existing.attempts} attempts - manual intervention required`);
        return existing;
      }
      
      // If IN_PROGRESS or retryable FAILED, return for recovery
      return existing;
    }

    // Create new job
    const jobId = this.generateJobId();
    
    this.db.prepare(`
      INSERT INTO fulfillment_jobs (
        job_id, session_id, transaction_id, kit_id, quantity, state
      ) VALUES (?, ?, ?, ?, ?, 'PENDING')
    `).run(jobId, sessionId, transactionId, kitId, quantity);

    const job = this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
    
    console.log(`✅ Fulfillment job created: ${jobId}`);
    console.log(`   Transaction: ${transactionId}, Kit: ${kitId}, Quantity: ${quantity}`);
    
    return job;
  }

  /**
   * Start dispensing (PENDING → IN_PROGRESS)
   * 
   * Publishes MQTT command to ESP32 and updates state
   * 
   * @param {string} jobId - Job ID
   * @returns {Promise<boolean>} - Success
   */
  async startDispensing(jobId) {
    const job = this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
    
    if (!job) {
      throw new Error(`Fulfillment job not found: ${jobId}`);
    }

    // SAFETY: Only PENDING jobs may be published to MQTT.
    // IN_PROGRESS jobs must NEVER be republished — the physical state is uncertain.
    if (job.state !== 'PENDING') {
      console.warn(`⚠️ Cannot start dispensing for job in state: ${job.state} (only PENDING allowed)`);
      return false;
    }

    // Prepare MQTT payload
    const topic = `reliv/dispense/${jobId}`;
    const payload = JSON.stringify({
      jobId,
      kitId: job.kit_id,
      quantity: job.quantity,
      timestamp: Date.now()
    });

    // Publish to MQTT
    if (!this.mqttClient) {
      throw new Error('MQTT client not configured');
    }

    return new Promise((resolve, reject) => {
      this.mqttClient.publish(topic, payload, { qos: 1 }, (error) => {
        if (error) {
          console.error(`❌ MQTT publish failed for ${jobId}:`, error.message);
          reject(error);
          return;
        }

        // Update job state
        this.db.prepare(`
          UPDATE fulfillment_jobs
          SET state = 'IN_PROGRESS',
              mqtt_topic = ?,
              mqtt_payload = ?,
              mqtt_published_at = datetime('now'),
              started_at = COALESCE(started_at, datetime('now')),
              attempts = attempts + 1
          WHERE job_id = ?
        `).run(topic, payload, jobId);

        console.log(`✅ Dispense command published: ${jobId}`);
        console.log(`   Topic: ${topic}`);
        console.log(`   Attempt: ${job.attempts + 1}/${job.max_attempts}`);
        
        resolve(true);
      });
    });
  }

  /**
   * Handle ESP32 ACK (IN_PROGRESS → COMPLETED)
   * 
   * @param {string} jobId - Job ID
   * @param {object} ackData - ACK payload from ESP32
   * @returns {Promise<boolean>} - Success
   */
  async markCompleted(jobId, ackData = {}) {
    const job = this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
    
    if (!job) {
      console.warn(`⚠️ Received ACK for unknown job: ${jobId}`);
      return false;
    }

    // Idempotent: already completed
    if (job.state === 'COMPLETED') {
      console.log(`⚠️ Job already completed (duplicate ACK): ${jobId}`);
      return true;
    }

    // Only IN_PROGRESS jobs can be completed
    if (job.state !== 'IN_PROGRESS') {
      console.warn(`⚠️ Cannot mark job as completed from state: ${job.state}`);
      return false;
    }

    // Validate ACK payload matches expected job
    if (ackData.kitId && ackData.kitId !== job.kit_id) {
      console.error(`❌ ACK kit mismatch for job ${jobId}: expected ${job.kit_id}, got ${ackData.kitId}`);
      return false;
    }
    if (ackData.quantity && ackData.quantity !== job.quantity) {
      console.error(`❌ ACK quantity mismatch for job ${jobId}: expected ${job.quantity}, got ${ackData.quantity}`);
      return false;
    }

    this.db.prepare(`
      UPDATE fulfillment_jobs
      SET state = 'COMPLETED',
          esp32_ack_received_at = datetime('now'),
          esp32_ack_payload = ?,
          completed_at = datetime('now')
      WHERE job_id = ?
    `).run(JSON.stringify(ackData), jobId);

    console.log(`✅ Fulfillment COMPLETED: ${jobId}`);
    console.log(`   Kit: ${job.kit_id}, Quantity: ${job.quantity}`);
    
    return true;
  }

  /**
   * Handle failures (IN_PROGRESS → FAILED or retry)
   * 
   * @param {string} jobId - Job ID
   * @param {string} errorMessage - Error description
   * @returns {Promise<boolean>} - Success
   */
  async markFailed(jobId, errorMessage) {
    const job = this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
    
    if (!job) {
      throw new Error(`Fulfillment job not found: ${jobId}`);
    }

    // Check if can retry
    if (job.attempts < job.max_attempts) {
      console.warn(`⚠️ Dispensing failed for ${jobId} (attempt ${job.attempts}/${job.max_attempts})`);
      console.warn(`   Error: ${errorMessage}`);
      console.warn(`   Will retry on next recovery cycle`);
      
      this.db.prepare(`
        UPDATE fulfillment_jobs
        SET state = 'PENDING',
            error_message = ?
        WHERE job_id = ?
      `).run(errorMessage, jobId);
      
      return false; // Will retry
    }

    // Max attempts exceeded
    this.db.prepare(`
      UPDATE fulfillment_jobs
      SET state = 'FAILED',
          error_message = ?,
          failed_at = datetime('now')
      WHERE job_id = ?
    `).run(errorMessage, jobId);

    console.error(`❌ Fulfillment FAILED after ${job.attempts} attempts: ${jobId}`);
    console.error(`   Error: ${errorMessage}`);
    console.error(`   Manual intervention required`);
    
    return true; // Permanently failed
  }

  /**
   * Recover pending/in-progress jobs after Pi restart
   * 
   * CRITICAL SAFETY RULES:
   * - PENDING jobs: Safe to retry (MQTT was never published)
   * - IN_PROGRESS jobs: UNSAFE to retry (physical dispense may have occurred)
   *   → These MUST go to MANUAL_REVIEW_REQUIRED
   * - NEVER automatically retry an uncertain physical operation
   * 
   * @returns {Promise<Array>} - PENDING jobs ready for retry
   */
  async recoverPendingJobs() {
    console.log('🔄 Recovering fulfillment jobs after restart...');
    
    // Handle IN_PROGRESS jobs first — these are UNSAFE
    const inProgressJobs = this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE state = 'IN_PROGRESS'
      ORDER BY created_at ASC
    `).all();

    if (inProgressJobs.length > 0) {
      console.warn(`⚠️  Found ${inProgressJobs.length} IN_PROGRESS jobs — marking for MANUAL REVIEW`);
      console.warn('   These jobs may have dispensed before Pi crashed. DO NOT auto-retry.');
      
      for (const job of inProgressJobs) {
        this.db.prepare(`
          UPDATE fulfillment_jobs
          SET state = 'MANUAL_REVIEW_REQUIRED',
              error_message = 'Pi restarted while job was IN_PROGRESS. Physical dispense state uncertain. Manual verification required before retry.'
          WHERE job_id = ?
        `).run(job.job_id);
        
        console.warn(`   ⚠️  Job ${job.job_id} → MANUAL_REVIEW_REQUIRED (kit: ${job.kit_id}, qty: ${job.quantity})`);
      }
    }

    // Handle PENDING jobs — these are safe to retry
    const pendingJobs = this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE state = 'PENDING'
      ORDER BY created_at ASC
    `).all();

    if (pendingJobs.length === 0 && inProgressJobs.length === 0) {
      console.log('   No pending jobs to recover');
      return [];
    }

    const recovered = [];
    
    for (const job of pendingJobs) {
      if (job.attempts >= job.max_attempts) {
        // Max attempts exceeded, mark as FAILED
        await this.markFailed(job.job_id, 'Max retry attempts exceeded after restart');
        console.log(`   ❌ Job ${job.job_id} failed (max attempts)`);
      } else {
        console.log(`   🔄 Job ${job.job_id} ready for retry (attempt ${job.attempts + 1}/${job.max_attempts})`);
        recovered.push(job);
      }
    }
    
    console.log(`✅ Recovery complete: ${recovered.length} PENDING jobs ready, ${inProgressJobs.length} jobs need manual review`);
    return recovered;
  }

  /**
   * Get all jobs requiring manual review
   * @returns {Array} - Jobs in MANUAL_REVIEW_REQUIRED state
   */
  getManualReviewJobs() {
    return this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE state = 'MANUAL_REVIEW_REQUIRED'
      ORDER BY created_at ASC
    `).all();
  }

  /**
   * Manually resolve a job after physical verification
   * Admin confirms whether the kit was actually dispensed or not
   * @param {string} jobId - Job ID
   * @param {string} resolution - 'COMPLETED' or 'PENDING' (to retry)
   * @returns {boolean} - Success
   */
  resolveManualReview(jobId, resolution) {
    const job = this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
    
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.state !== 'MANUAL_REVIEW_REQUIRED') {
      throw new Error(`Job ${jobId} is not in MANUAL_REVIEW_REQUIRED state (current: ${job.state})`);
    }

    if (resolution === 'COMPLETED') {
      this.db.prepare(`
        UPDATE fulfillment_jobs
        SET state = 'COMPLETED',
            completed_at = datetime('now'),
            error_message = 'Manually confirmed as dispensed after review'
        WHERE job_id = ?
      `).run(jobId);
      console.log(`✅ Job ${jobId} manually marked COMPLETED`);
    } else if (resolution === 'PENDING') {
      this.db.prepare(`
        UPDATE fulfillment_jobs
        SET state = 'PENDING',
            error_message = 'Manually confirmed NOT dispensed - safe to retry'
        WHERE job_id = ?
      `).run(jobId);
      console.log(`🔄 Job ${jobId} reset to PENDING for retry`);
    } else {
      throw new Error(`Invalid resolution: ${resolution}. Must be 'COMPLETED' or 'PENDING'`);
    }

    return true;
  }

  /**
   * Get job status
   * 
   * @param {string} jobId - Job ID
   * @returns {object|null} - Job status
   */
  getJobStatus(jobId) {
    return this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
  }

  /**
   * Get all jobs for a session
   * 
   * @param {string} sessionId - Session ID
   * @returns {Array} - Jobs
   */
  getSessionJobs(sessionId) {
    return this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE session_id = ?
      ORDER BY created_at DESC
    `).all(sessionId);
  }

  /**
   * Get pending jobs (for manual review/retry)
   * 
   * @returns {Array} - Pending jobs
   */
  getPendingJobs() {
    return this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE state IN ('PENDING', 'IN_PROGRESS')
      ORDER BY created_at ASC
    `).all();
  }

  /**
   * Retry a specific job
   * 
   * @param {string} jobId - Job ID
   * @returns {Promise<boolean>} - Success
   */
  async retryJob(jobId) {
    const job = this.db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id = ?').get(jobId);
    
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.state !== 'PENDING') {
      console.warn(`⚠️ Cannot retry job ${jobId}: state is ${job.state} (must be PENDING)`);
      return false;
    }

    if (job.attempts >= job.max_attempts) {
      console.warn(`⚠️ Cannot retry job ${jobId}: max attempts exceeded`);
      return false;
    }

    console.log(`🔄 Manually retrying job: ${jobId}`);
    await this.startDispensing(jobId);
    return true;
  }
}

// Singleton instance
const fulfillmentManager = new FulfillmentManager();

export default fulfillmentManager;
