import express from 'express';
export function mountMedicineImages(app, directory) {
  // /api is forwarded to Express by the Pi's existing nginx configuration.
  // Retain the legacy URL for clients that connect directly to port 5000.
  app.use(['/medicine-images', '/api/medicine-images'], express.static(directory, {
    maxAge: 0, etag: true, fallthrough: false,
  }));
}
