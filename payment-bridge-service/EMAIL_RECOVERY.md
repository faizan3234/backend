# Receipt/report sender recovery

Gmail `535 5.7.8` / `EMAIL_AUTH_FAILED` means Gmail rejected the **sending account's login**. It is not caused by the customer's email address, the Pi microphone or the payment code.

Run these commands on the **cloud host running payment-bridge-service**, from that service's directory. The two settings used by both cloud receipt and health-report mail are:

```
RECEIPT_GMAIL_USER=your-sending-account@gmail.com
RECEIPT_GMAIL_APP_PASSWORD=your-16-character-app-password
```

1. Sign into that same Google account. Enable 2-Step Verification and create an app password. Ordinary Gmail passwords do not replace an app password. Changing the Google account password revokes existing app passwords. Some managed accounts or security policies do not allow them; ask the account administrator for an approved SMTP/OAuth configuration.
2. Update the service's private `.env` or hosting environment. Do not put the password in Git, shell command arguments, screenshots or chat. Spaces in the displayed app password are stripped by the sender.
3. In `payment-bridge-service`, run `node check-email.js`. It verifies login and sends **no message**. A successful check is not proof of inbox delivery.
4. Restart this cloud service using its existing process manager. For PM2 use `pm2 restart <actual-bridge-process-name> --update-env` (find the name with `pm2 list`). Other hosts: restart/redeploy the bridge with its normal controls. Running `node server.js` on the kiosk does not restart the cloud bridge.
5. On the already-paid phone page, retry **email delivery**. Do not pay again. Existing paid-order verification, receipt audit records and sent-message duplicate protection still apply.

Official account instructions: https://support.google.com/accounts/answer/185833

No code change can repair a revoked or incorrect account credential. New customer-facing errors hide SMTP diagnostics and distinguish an administrator action from a temporary sending problem.
