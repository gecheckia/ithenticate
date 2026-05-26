FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
# Instalamos Puppeteer para que no falle el PDF
RUN npx puppeteer browsers install chrome
COPY . .
CMD ["npm", "start"]
