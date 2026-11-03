import { publicUrl } from "./request";

export const agentImage = () => process.env.AGENT_IMAGE ?? "ghcr.io/chickenbone/mint-agent:latest";

/** Compose file volunteers download. Keep in sync with docker-compose.agent.yml in the repo root. */
export function workerCompose() {
  return `# Mint volunteer worker: ${publicUrl()}/app/workers
#   1. Put your token in a .env file next to this one:  MINT_WORKER_TOKEN=mint_wk_...
#   2. docker compose up -d
# Needs outbound HTTPS only. No ports are opened on this machine.
name: mint-worker

services:
  agent:
    image: ${agentImage()}
    restart: unless-stopped
    environment:
      MINT_URL: ${publicUrl()}
      MINT_WORKER_TOKEN: \${MINT_WORKER_TOKEN:?put MINT_WORKER_TOKEN in .env}
      COBALT_URL: http://cobalt:9000
      AGENT_CONCURRENCY: \${AGENT_CONCURRENCY:-2}
    volumes: [work:/work]
    depends_on: [cobalt]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

  cobalt:
    image: ghcr.io/imputnet/cobalt:11
    restart: unless-stopped
    init: true
    read_only: true
    environment:
      API_URL: http://cobalt:9000/
      API_PORT: "9000"
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

volumes:
  work: {}
`;
}
