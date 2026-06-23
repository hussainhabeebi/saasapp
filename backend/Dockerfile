FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY nba.js .

ENV NOCODB_BASE=https://whizz.aiingo.com
ENV NOCODB_TOKEN=
ENV CLIENTS_TABLE=mxl33bg4wi70fqj
ENV RUN_NOW=0

# Timezone for cron (override with -e TZ=Asia/Dubai etc.)
ENV TZ=UTC

CMD ["node", "nba.js"]
