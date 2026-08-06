FROM nginx:alpine

# Build identity — injected by CI (Jenkins passes --build-arg BUILD_NUMBER=${BUILD_NUMBER}).
# Falls back to "dev" for local `docker compose up --build` so the app still works untagged.
ARG BUILD_NUMBER=dev
ARG APP_VERSION=1.0

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html

# version.json is what the running app polls to detect a new deploy. It is written at
# image-build time (not committed) so every rebuild necessarily produces a new value —
# there is no manual step that can be skipped.
RUN printf '{"version":"%s.%s","build":"%s"}\n' "$APP_VERSION" "$BUILD_NUMBER" "$BUILD_NUMBER" \
      > /usr/share/nginx/html/version.json

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
