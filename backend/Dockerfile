FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY nba.js recovery.js ./

ENV NOCODB_BASE=https://whizz.aiingo.com
ENV NOCODB_TOKEN=
ENV CLIENTS_TABLE=mxl33bg4wi70fqj
ENV RUN_NOW=0
# Only used by recovery.js, only for clients with Voice Follow-ups turned on (see SETUP.md)
ENV SARVAM_API_KEY=

# Timezone for cron (override with -e TZ=Asia/Dubai etc.)
ENV TZ=UTC

# leadvyne-recovery overrides this command via docker-compose to run recovery.js instead
CMD ["node", "nba.js"]
