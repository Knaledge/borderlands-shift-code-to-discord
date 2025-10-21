FROM node:current-alpine

LABEL org.opencontainers.image.source="https://github.com/Knaledge/borderlands-shift-code-to-discord"
LABEL org.opencontainers.image.description="Docker container for hosting a Borderlands SHiFT code scraper which publishes to Discord webhook"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY core ./core
COPY publication-targets ./publication-targets
COPY shift-code-sources ./shift-code-sources

ENV NODE_ENV=production

CMD ["node", "core/index.js"]
