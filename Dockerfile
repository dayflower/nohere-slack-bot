FROM node:10-alpine

WORKDIR /usr/src/app

RUN apk add --no-cache tini
ENTRYPOINT [ "/sbin/tini", "--" ]

COPY package*.json ./

RUN npm install

COPY index.js .
RUN mkdir -p ./examples
COPY examples/bot.js ./examples/

CMD [ "npm", "start" ]
