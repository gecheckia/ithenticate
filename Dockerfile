# Use Puppeteer's official image — incluye Chromium + todas las libs del sistema
FROM ghcr.io/puppeteer/puppeteer:23.5.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
