# Soulia — From order to delivery

The rebuilt product advertisement: exactly 90 seconds, 1080 × 1920, 30 FPS, twelve scenes, 41 editorial beats, original stereo electronic music and synchronized UI accents.

## Delivery

- `Soulia-From-Order-to-Delivery-90s.mp4` — complete H.264/AAC Reel.
- `Soulia-Editable-Source.zip` — source, assets, dependency lockfiles and verification metadata. Extract into `artifacts/product-reel` in the existing workspace.
- `composition.js`, `composition.html`, `timeline.json` — editable, frame-deterministic composition.
- `capture.cjs`, `prepare-assets.cjs`, `audio.cjs`, `render.cjs`, `verify.cjs` — capture, production and verification scripts.
- `assets/` — native UI captures, focused crops, the original Soulia mark, original soundtrack and SRT text.
- `review/encoded-contact-sheet.png` — frames extracted from the delivered MP4, one per editorial beat.
- `verification.json`, `decode-check.txt`, `audio-measurements.txt`, `capture-audit.json` — export and capture evidence.
- `FEATURE-MATRIX.md` — source evidence, scene decisions, explicit fallback matrix and content priority hierarchy.

The previous film remains in the parent directory. This edition is isolated in `premium-v2`; it does not change application source, business logic or production data.

## What the film demonstrates

The main journey follows DEMO-1001 through the actual order interface, delivery details, confirmation controls, employee assignment, product availability, warehouse preparation, piece scanning, Bosta tracking controls and the supported Delivered state. The second section shows order payment details, an approved expense, account filters, supplier records, an after-sales return request, roles, permissions, customer follow-up, a daily order report and transaction history. The ending uses the actual main dashboard KPI component with its native financial privacy mode, then the original Soulia logo.

The film uses the shipped application HTML/CSS/JavaScript. These are authentic interface components, separated into layers and art-directed for portrait viewing. The advertisement's headlines, connectors, progress rails and motion are editorial graphics, not invented product UI. Screenshots are rendering inputs; the output uses staggered card movement, masks, typography reveals, handoff, scan, tracking and convergence sequences with a new composition every 2–2.5 seconds.

## Demonstration scope

All data is deliberately synthetic and visibly labeled `DEMO DATA`. The EGP 300 order consists of two EGP 150 items; the example expense is EGP 20; initial stock is 12, 9, 6 and 3 pieces. The 100% report represents exactly one demonstration order, not company performance. Report values and assignment workload are computed by the actual frontend. No real customer, employee, phone number, financial balance or order is used.

This is a staged offline product film, not evidence of end-to-end backend execution. The capture never connects to the live backend or a carrier. Two piece-scan interactions run through the actual frontend against an in-memory API fixture. Later shipping and delivery states are explicitly supplied demonstration fixtures using supported state values. Showing Delivered does not imply a real delivery occurred. The order's paid/remaining figures are not changed to imply a carrier settlement.

Label preview is shown as the actual native control; no carrier waybill is manufactured. Automatic messages, automated address validation, a customer tracking portal, live stock synchronization, real settlement, workforce performance, and live financial balances are not claimed. Several permission labels are Arabic in the application's English mode and are preserved. Product images use the application's own placeholders, avoiding invented product photography. The scanner highlight is an editorial emphasis on real scan UI; no camera scanning is claimed.

## Re-render from this workspace

Node.js, the repository's existing Puppeteer/Chromium installation and the parent media dependencies are used. There is no production server prerequisite. Rendering uses a local browser canvas plus FFmpeg because this project is Express with plain browser JavaScript, not a React application.

```powershell
# From D:\website\Souliahome
npm ci --prefix artifacts/product-reel
# If backend dependencies / Chromium are not already installed:
npm ci --prefix backend

# Recreate UI captures and crops
npm run capture --prefix artifacts/product-reel/premium-v2

# Generate the original 120 BPM music and sound effects
npm run audio --prefix artifacts/product-reel/premium-v2

# Review every shot before exporting
npm run storyboard --prefix artifacts/product-reel/premium-v2

# Render all 2,700 frames, add music, then verify
npm run render --prefix artifacts/product-reel/premium-v2
npm run verify --prefix artifacts/product-reel/premium-v2
```

`npm run preview --prefix artifacts/product-reel/premium-v2` prints a localhost URL with playback, audio and a timeline scrubber. The preview server binds only to loopback. Ctrl+C stops it.

To rerender specific scenes after editing the composition, keep the other clips and run:

```powershell
node artifacts/product-reel/premium-v2/render.cjs --scene=3,8
node artifacts/product-reel/premium-v2/verify.cjs
```

After changing `timeline.json`, rerun `prepare-assets.cjs` and `audio.cjs` before rendering. Scene starts and durations must retain the exact 90-second timeline. Re-capturing requires the current repository source; packaged assets alone are sufficient for rerendering without a recapture. The parent `package-lock.json` pins Sharp and FFmpeg. The backend lockfile pins Puppeteer. The composition uses the installed Segoe UI font with Arial fallback; the current Windows environment provides both. Font files are not redistributed.

## Sound

`audio.cjs` composes an original D-minor electronic score at 120 BPM with kick, bass, soft percussion, chord pads, arpeggios, UI ticks, transition accents and a resolved musical ending. There are no downloaded tracks or third-party samples. Every major cut lands on a beat; UI verification accents match the relevant scene transitions. Audio is 48 kHz stereo, encoded to AAC at 256 kb/s. Measured final loudness and true peak are in `verification.json`.

## Verification

The verifier checks the twelve required scene boundaries, 41 beat durations, 90-second browser metadata, 1080 × 1920 geometry, 30 FPS, all 2,700 decoded frames, stereo audio, loudness and peak headroom. It seeks to every edit boundary, plays the ending to completion in Chromium, and extracts the encoded frames for visual review. Capture assertions check the initial Unconfirmed state, the two verified pieces and the supported Delivered state. Unrelated application regression tests are not part of this isolated media change.
