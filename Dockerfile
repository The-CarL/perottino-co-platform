FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
# A TLS-inspecting build environment can supply its public trust certificate
# with --secret id=build_ca,src=/path/to/ca.pem. It never enters the image.
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund \
    && node node_modules/@openai/codex/bin/codex.js --version

# The browser binaries and their system libraries are baked into this pinned
# image. Its Playwright version must match playwright-core in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.57.0-noble@sha256:3bed4b1a12f2338642f3d8cba28e291deef3c66bd4a964bbeb3e57bbff511dbd
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/var/lib/perottino \
    HOME=/home/perottino \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=dependencies /build/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN chmod -R a+rX,go-w src public package.json \
    && install -d -m 0700 -o 1000 -g 1000 /var/lib/perottino /home/perottino /run/perottino-render /run/perottino-worker
USER 1000:1000
RUN node --input-type=module -e "import { accessSync, constants } from 'node:fs'; import { chromium } from 'playwright-core'; import 'node:sqlite'; accessSync(chromium.executablePath(), constants.X_OK)"
EXPOSE 3000
CMD ["node", "src/server.mjs"]
