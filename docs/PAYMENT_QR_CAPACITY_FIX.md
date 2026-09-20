Payment QR capacity fix
=======================

The cloud key generator uses RSA-4096. The old encrypted package wrapped
Base64 ciphertext in JSON and then Base64 again. Real one-, two- and three-kit
requests measured approximately 2527, 2874 and 3203 bytes. Frontend PR #28
rejected every URL above 2200 bytes; the largest exceeded even QR level L.
Earlier backend tests used RSA-2048 and never attempted to encode a QR.

The frontend fix selects level M up to 2331 bytes and level L up to 2953,
preserves existing requests on retry, and explains a genuinely oversized QR.
This backend fix compresses the signed inner envelope before encryption.
The sample medicine URLs are approximately 1956–2098 bytes. A full health
snapshot is approximately 2451 bytes and needs the frontend level-L support.
Sizes vary with the actual details and random signatures.

Deployment order is required:

1. Deploy the frontend payment-capacity fix (PR #30) to the kiosk.
2. Deploy this backend revision to the Oracle payment bridge and restart the
   bridge process. Its decoder accepts both old and compressed envelopes.
3. Deploy this revision to the Pi backend and restart that process. New
   payment requests now use compressed envelopes. The Pi stays offline.

Do not deploy the new Pi producer before the cloud decoder: an old bridge
cannot open compressed requests. No key regeneration, pepper change, database
reset or payment-record deletion is needed. Keep the bridge decoder if rolling
the Pi producer back; it remains compatible with legacy requests.

Existing requests are preserved byte-for-byte for payment recovery. A legacy
request larger than 2953 bytes remains too large to display; the Pi cannot
decrypt it to recompress it. If it was never paid, cancel/back out or let it
expire and create a fresh compressed request. If money was deducted, recover
the existing payment and activation code; do not create another charge.

Security remains Ed25519 signing, RSA-OAEP-SHA256 plus AES-256-GCM, and the
existing code HMAC/request binding. The compression marker is authenticated
as GCM additional data. Both decoders cap decompression at 64 KiB, reject
unknown compression and modified ciphertext, and continue accepting legacy
packages. Requests beyond QR capacity are rejected before persisting an
unusable active QR; signed data is never truncated.

Regression coverage uses real SQLite-backed request creation, RSA-4096,
actual QR encoding, receipt quantities/amounts, Unicode health snapshots,
legacy recovery, signature/tamper checks, bounded decompression, and cloud
order idempotency across the two encodings. The frontend fixtures contain
only synthetic expired test payments, never real customer or production keys.
