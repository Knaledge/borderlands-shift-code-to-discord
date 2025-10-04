FROM node:current-alpine3.21

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY core ./core
COPY publication-targets ./publication-targets
COPY shift-code-sources ./shift-code-sources

ENV NODE_ENV=production

CMD ["node", "core/index.js"]
