FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /build
COPY package.json package-lock.json ./
# An optional public CA is available to npm only during this build step.
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund
RUN rm -rf node_modules/@aws-sdk/client-secrets-manager node_modules/@aws-sdk/client-ecs node_modules/quickjs-emscripten* node_modules/@jitl node_modules/@aws-sdk/client-s3 node_modules/@aws-sdk/client-sesv2

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
# Native HTTPS clients discover this system bundle independently of Node's TLS configuration.
RUN mkdir -p /etc/ssl/certs \
    && node -e 'require("node:fs").writeFileSync("/etc/ssl/certs/ca-certificates.crt", require("node:tls").rootCertificates.join("\n") + "\n", {mode: 0o644})'
WORKDIR /app
COPY --from=dependencies /build/node_modules ./node_modules
COPY package.json ./
COPY src/telemetry.mjs src/company-worker.mjs src/company-capabilities.mjs src/company-decisions.mjs src/company-governance.mjs src/company-work.mjs src/company-notifications.mjs src/company-events.mjs src/foundation-records.mjs src/resident.mjs src/employee-store.mjs src/headcount.mjs src/cloud-store.mjs src/agent.mjs src/agentcore-browser.mjs src/company-browser-budget.mjs src/browser.mjs src/renderer.mjs src/private-socket.mjs src/bedrock-relay.mjs ./src/
RUN chmod -R a+rX,go-w src package.json \
    && node node_modules/@openai/codex/bin/codex.js --version \
    && node --input-type=module -e "await import('./src/cloud-store.mjs'); await import('./src/company-worker.mjs')"
USER 1000:1000
# A resident employee checks its durable inbox and goals until employment or the task ends.
CMD ["node", "src/resident.mjs"]
