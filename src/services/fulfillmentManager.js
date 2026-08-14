import { getDb } from '../database/db.js';
import crypto from 'crypto';

/**
 * Fulfillment State Machine
 * 
 * Manages the complete dispensing lifecycle with:
 * - Idempotent fulfillment (prevent double-dispense)
 * - State tracking (PENDING → IN_PROGRESS → COMPLETED / FAILED)
 * - Restart recovery (Pi can crash and recover safely)
 * - Retry logic (max 3 attempts)
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
 *           → IN_PROGRESS → FAILED ❌ (after 3 attempts)
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

    if (job.state !== 'PENDING' && job.state !== 'IN_PROGRESS') {
      console.warn(`⚠️ Cannot start dispensing for job in state: ${job.state}`);
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

    if (job.state === 'COMPLETED') {
      console.log(`⚠️ Job already completed: ${jobId}`);
      return true;
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
   * This is CRITICAL for preventing double-dispense:
   * 1. Find IN_PROGRESS jobs (may have been dispensed before crash)
   * 2. Check attempts
   * 3. If < max_attempts, retry
   * 4. If >= max_attempts, mark FAILED
   * 
   * @returns {Promise<Array>} - Recovered jobs
   */
  async recoverPendingJobs() {
    console.log('🔄 Recovering pending fulfillment jobs after restart...');
    
    const pendingJobs = this.db.prepare(`
      SELECT * FROM fulfillment_jobs
      WHERE state IN ('PENDING', 'IN_PROGRESS')
      ORDER BY created_at ASC
    `).all();

    if (pendingJobs.length === 0) {
      console.log('   No pending jobs to recover');
      return [];
    }

    console.log(`   Found ${pendingJobs.length} pending/in-progress jobs`);
    
    const recovered = [];
    
    for (const job of pendingJobs) {
      if (job.attempts >= job.max_attempts) {
        // Max attempts exceeded, mark as FAILED
        await this.markFailed(job.job_id, 'Max retry attempts exceeded after restart');
        console.log(`   ❌ Job ${job.job_id} failed (max attempts)`);
      } else {
        // Reset to PENDING for retry
        this.db.prepare(`
          UPDATE fulfillment_jobs
          SET state = 'PENDING'
          WHERE job_id = ?
        `).run(job.job_id);
        
        console.log(`   🔄 Job ${job.job_id} reset to PENDING (attempt ${job.attempts + 1}/${job.max_attempts})`);
        recovered.push(job);
      }
    }
    
    console.log(`✅ Recovery complete: ${recovered.length} jobs ready for retry`);
    return recovered;
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
