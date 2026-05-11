FROM node:20-alpine

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar código fuente
COPY . .

# Puerto del servidor
EXPOSE 3000

# Variables de entorno requeridas (se pasan al correr el contenedor)
ENV NODE_ENV=production

CMD ["node", "server.js"]
