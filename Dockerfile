# Evolve Health: the web app and a storage node in one small image. No npm dependencies.
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE NOTICE ./
COPY web ./web
COPY node ./node
RUN mkdir -p /data && chown node:node /data
USER node
ENV EH_HOST=0.0.0.0 EH_PORT=8787 EH_DATA=/data EH_APP=/app/web
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/v1/info >/dev/null || exit 1
CMD ["node", "node/server.mjs"]
