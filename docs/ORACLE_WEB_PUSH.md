# Oracle Web Push Notifications

The Reliv customer PWA already creates browser PushSubscription objects and has a service-worker push handler. The Oracle payment bridge must provide the server-side Web Push sender.

## Runtime

The production Oracle bridge is managed by systemd:

`reliv-cloud-bridge.service`

Do not create a separate PM2 payment bridge. Push routes and the scheduler run inside the existing Node process on port 10000.

## Oracle setup

From `/home/ubuntu/backend/payment-bridge-service`:

1. Install the Web Push sender once:

```bash
npm install web-push@3.6.7 --no-save
```

2. Generate one VAPID key pair:

```bash
node generate-vapid-keys.js
```

Copy both generated values into the existing `.env`:

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:relivcustomercare.in@gmail.com
RELIV_APP_BASE_URL=https://reliv7.vercel.app
PUSH_SCHEDULER_INTERVAL_MS=60000
```

Never put the private VAPID key in frontend code or GitHub.

3. Restart the existing service:

```bash
sudo systemctl restart reliv-cloud-bridge.service
sleep 3
systemctl is-active reliv-cloud-bridge.service
```

## Endpoints

- `GET /api/notifications/vapid-public-key`
- `GET /api/notifications/health`
- `POST /api/notifications/subscribe`
- `POST /api/notifications/test`

The global bridge CORS allowlist still applies. The test route only sends to a subscription that was already registered, so Oracle cannot be used as an arbitrary public push relay.

Subscriptions and reminder settings are stored in the existing Oracle SQLite bridge database in `push_subscriptions`. No loose JSON subscription file is required.

## Verification

Local:

```bash
curl -sS http://127.0.0.1:10000/api/notifications/health
curl -sS http://127.0.0.1:10000/api/notifications/vapid-public-key
```

Public through nginx:

```bash
curl -sS https://80.225.243.51/api/notifications/health
```

Expected health fields include:

```json
{
  "status": "healthy",
  "service": "reliv-oracle-push-bridge",
  "schedulerRunning": true,
  "webpushAvailable": true,
  "vapidConfigured": true
}
```

Logs:

```bash
sudo journalctl -u reliv-cloud-bridge.service -n 100 --no-pager | grep -Ei 'PushBridge|error|failed'
```

A real device test requires the PWA to be installed where required by the OS, notification permission granted, and the phone to successfully register a PushSubscription with Oracle.
