FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# The build stage only needs to compile TypeScript, so skip fetching Chromium here.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

# ── PDF export (reports) ──────────────────────────────────────────────────
# `ReportsExportService.buildPdf` renders the report through headless Chromium.
#
# ⚠ Alpine's Chromium must be installed from the distro. Puppeteer's own
# bundled build is glibc-linked and CANNOT run on musl — it fails at launch with
# a bare ENOENT that reads like a missing file rather than a wrong binary. So
# the download is skipped and PUPPETEER_EXECUTABLE_PATH points at the system one.
#
# ⚠ The font packages are NOT optional. Chromium ships no fonts of its own, and
# without an Arabic face every Arabic glyph on the sheet renders as an empty box
# (□□□) while the PDF still generates "successfully" — a silent, whole-document
# failure. ttf-dejavu covers the Latin digits and EGP.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-dejavu \
      font-noto \
      font-noto-arabic

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
