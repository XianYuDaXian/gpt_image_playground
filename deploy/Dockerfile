FROM node:20-bookworm-slim AS web-build

WORKDIR /app
ARG TARGETARCH
ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci
RUN resolved_arch="${TARGETARCH}"; \
    if [ -z "$resolved_arch" ]; then \
      case "$(uname -m)" in \
        x86_64) resolved_arch="amd64" ;; \
        aarch64|arm64) resolved_arch="arm64" ;; \
        *) echo "Unsupported uname -m: $(uname -m)" && exit 1 ;; \
      esac; \
    fi; \
    case "$resolved_arch" in \
      "amd64") npm install --no-save @rollup/rollup-linux-x64-gnu ;; \
      "arm64") npm install --no-save @rollup/rollup-linux-arm64-gnu ;; \
      *) echo "Unsupported TARGETARCH: $resolved_arch" && exit 1 ;; \
    esac

COPY . .
RUN npm run build:web


FROM node:20-bookworm-slim AS server-build

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server ./
RUN npm run build


FROM node:20-bookworm-slim AS server-prod-deps

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:20-bookworm-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV WEB_DIST_DIR=/app/dist

COPY --from=server-prod-deps /app/server/node_modules /app/server/node_modules
COPY --from=server-build /app/server/dist /app/server/dist
COPY --from=server-build /app/server/package.json /app/server/package.json
COPY --from=web-build /app/dist /app/dist

RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "/app/server/dist/index.js"]
