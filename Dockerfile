# Node 20 mit FFmpeg vorinstalliert
FROM node:20-slim

# FFmpeg installieren (das ist der ganze Grund fuer diesen Dienst)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Abhaengigkeiten zuerst (besseres Caching)
COPY package.json ./
RUN npm install --omit=dev

# Restlichen Code kopieren
COPY . .

# Railway setzt PORT automatisch; Standard 8080
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
