# Advertising media performance — 30 September 2026

The display configuration and preparation target now match the Waveshare 10.1-inch 1280×800 panel. This replaces the previous 1920×1080 / 11.6-inch configuration.

## Preparation and delivery

- Reduce high-frame-rate video to 30 fps before scaling/blur.
- Blur only a 160×100 decorative background and scale it up; retain the detailed foreground without cropping its content.
- Encode H.264/yuv420p using `veryfast`, CRF 23, 4 Mbit/s maximum rate, 8 Mbit buffer and front-loaded MP4 metadata. Preserve existing AAC audio normalization and the 15-second playback limit.
- Produce 1280×800 WebP pictures at quality 85, compression level 3.
- Return the SHA-256 media revision in preview/playlist URLs. Correct version URLs are privately cacheable; unversioned URLs revalidate and mismatched hashes fail. ETags and HTTP byte ranges remain supported. Payment/config/playlist responses are not made immutable.
- Preserve original 150 MB video / 20 MB picture input limits. A large original video must still cross the local Wi-Fi before processing; short exports load faster.

## Local comparison (not Raspberry Pi measurements)

Same execution machine and source fixtures, sequential old/new runs:

| Fixture | Old preparation | New preparation | Old bytes | New bytes |
| --- | ---: | ---: | ---: | ---: |
| 1800×2400 synthetic picture | 365 ms | 281 ms | 47,896 | 21,950 |
| 6-second 720×1280, 30 fps synthetic video | 4,439 ms | 1,144 ms | 1,513,532 | 631,642 |

The video prepared about 3.9× faster in this sample. These results are not a guaranteed Pi speed or a representative visual-quality score for every creative.

## Checks and deployment

Seven ad tests pass, including real FFmpeg portrait pictures/video with and without audio, exact 16:10 fitting, preservation of 16:9 artwork, 1280×800 output, H.264/30 fps/faststart metadata, signed payment/activation, cache revalidation, byte ranges and rejection of wrong media revisions. Existing kiosk and payment regression suites also pass.

Deploy this backend on the Pi and the matching frontend performance PR. Restart the existing local backend process; rebuild/deploy the frontend and refresh Chromium. Oracle payment bridge, pepper, keys, database and paid campaign files do not need modification. Do not re-encode existing signed paid media in place. Existing campaigns benefit from caching and the frontend's lightweight background fill; new uploads use the smaller output format.

Check actual upload/preparation/playback timing and fitting on the Pi, plus a real phone payment followed by code entry. A paid future campaign remains scheduled until its booked time. No real customer payment/email or physical-device performance was verified here.
