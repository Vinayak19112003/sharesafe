FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node media/ ./media/

ENV HOST=0.0.0.0 PORT=3000 NODE_USE_ENV_PROXY=1
USER node
EXPOSE 3000
CMD ["node", "server.js"]
