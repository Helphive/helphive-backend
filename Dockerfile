FROM node:20.15.0-alpine

WORKDIR /app

COPY package.json yarn.lock ./

# Install dependencies using Yarn
RUN yarn install

# Copy the rest of the application code
COPY . .

# Compile TypeScript files
RUN yarn build

# Expose the application port
EXPOSE 8080

# Start the application using the compiled JavaScript file
CMD ["node", "dist/index.js"]