FROM node:22-alpine

WORKDIR /app

# Install development dependencies
RUN apk add --no-cache libc6-compat bash git

# Install Claude Code CLI and OpenSpec globally (as root)
RUN npm install -g @anthropic-ai/claude-code @fission-ai/openspec

# Switch to non-root node user (UID=1000, matches host user)
RUN chown -R node:node /app
USER node

ENV PATH="/home/node/.local/bin:$PATH"
RUN claude install

COPY --chown=node:node package*.json ./
RUN npm install

COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
RUN chmod +x /home/node/entrypoint.sh

EXPOSE 4321

ENTRYPOINT ["/home/node/entrypoint.sh"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
