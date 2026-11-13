FROM node:22-alpine AS runtime-assets
WORKDIR /app
COPY public ./public
COPY scripts/build-runtime.cjs ./scripts/build-runtime.cjs
RUN node scripts/build-runtime.cjs

FROM nginx:alpine

# Build identity — injected by CI (Jenkins passes --build-arg BUILD_NUMBER=${BUILD_NUMBER}).
# Falls back to "dev" for local `docker compose up --build` so the app still works untagged.
ARG BUILD_NUMBER=dev
ARG APP_VERSION=1.0
# Jenkins exports GIT_COMMIT; shown (short) in Settings' version footer. Optional.
ARG GIT_COMMIT=

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
COPY --from=runtime-assets /app/runtime/ /usr/share/nginx/html/

# version.json is what the running app polls to detect a new deploy. It is written at
# image-build time (not committed) so every rebuild necessarily produces a new value —
# there is no manual step that can be skipped. builtAt (UTC) and commit feed the
# «إصدار النظام / آخر رفع» footer in Settings — the real figures of this deploy.
RUN printf '{"version":"%s.%s","build":"%s","builtAt":"%s","commit":"%s"}\n' \
      "$APP_VERSION" "$BUILD_NUMBER" "$BUILD_NUMBER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(printf '%s' "$GIT_COMMIT" | cut -c1-7)" \
      > /usr/share/nginx/html/version.json

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
