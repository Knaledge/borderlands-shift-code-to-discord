# Borderlands SHiFT Code → Discord (Linux)

## Overview
Docker-first automation that continuously scrapes the subreddit 'r/borderlandsshiftcodes' for newly shared Borderlands SHiFT codes, deduplicates them via Redis, enriches each entry with context/expiry intelligence, and posts curated embeds to a Discord webhook. The watcher politely respects Reddit rate limits, retries transient failures, and keeps long-term codes on a resend cadence so communities stay informed about expiring rewards.

### Features
- **Reddit ingestion pipeline** with configurable subreddit, pagination, and lookback window
- **Context-aware parsing** that normalizes code metadata, extracts expirations, and groups golden key variants
- **Redis-backed state** to track first-seen timestamps, resend throttling, and fault retries
- **Discord webhook embeddings** bundling sources, redemption links, and interactive buttons per post
- **Robust retry & backoff** for both Reddit fetches and Discord deliveries, including handling of rate limits
- **Graceful worker lifecycle** featuring interval polling, health logging, and signal-aware shutdown
- **Secret-aware config** leveraging Docker-native secrets for Discord and Redis credentials

#### Coming Soon
- Multi-source aggregation (Twitter, Gearbox newsfeeds, partner discords)
- Metrics export (Prometheus) and structured logging

### Thanks & Credits
Huge thanks to the r/Borderlands community, the maintainers of 'r/borderlandsshiftcodes, and countless fans sharing codes

---

## Recommended Host Requirements

* 1 vCPU & 512 MB RAM (absolute minimum for low-frequency polling)
* 2 vCPU & 2 GB RAM (comfortable for production cadence + Redis)
* Storage: ≥ 1 GB (Redis append-only log + Docker layers)

## Container Image Tags

| Tag         | Description                                |
|-------------|--------------------------------------------|
| `latest`    | Most recent production-ready container     |
| `<commit>`  | Immutable build for a specific git commit  |
| `dev`       | Preview build published from integration   |

## Environment Variables

> [!NOTE]
> Defaults mirror values in [`docker-compose.yml`](./docker-compose.yml) and can be overridden at runtime.

> [!WARNING]
> Invalid values fall back to defaults; ensure production overrides align with desired polling cadence and retry policies.

| Variable                    | Validated | Default                                | Type                   | Description                                                                                                                      |
|-----------------------------|:---------:|----------------------------------------|------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `NODE_ENV`                  |           | `production` (via compose)             | string                 | Node.js runtime mode; use `development` for verbose logging                                                                      |
| `DISCORD_WEBHOOK_URL`       |    Yes    | *secret*                               | string (URL)           | Direct webhook URL override; typically unset so the Docker secret is used                                                        |
| `DISCORD_WEBHOOK_SECRET`    |           | `discord_webhook_url`                  | string                 | Name of Docker secret file containing the Discord webhook URL                                                                    |
| `POLL_INTERVAL_MINUTES`     |    Yes    | `120`                                  | integer (≥1)           | Interval between poll cycles                                                                                                     |
| `RETRY_ATTEMPTS`            |    Yes    | `4`                                    | integer (≥1)           | Max retries for Reddit/Discord interactions                                                                                      |
| `RETRY_BASE_DELAY_MS`       |    Yes    | `2000`                                 | integer (≥250)         | Initial backoff delay for retry attempts                                                                                         |
| `REDDIT_SUBREDDIT`          |           | `borderlandsshiftcodes`                | string                 | Subreddit to monitor for SHiFT code drops                                                                                        |
| `REDDIT_USER_AGENT`         |           | `BorderlandsSHiFTCodePublishing/1.0`   | string                 | Custom user agent required by Reddit API policy                                                                                  |
| `REDDIT_LOOKBACK_DAYS`      |    Yes    | `30`                                   | integer (≥1)           | Historical window of posts to scan                                                                                               |
| `REDDIT_MAX_PAGES`          |    Yes    | `6`                                    | integer (≥1)           | Maximum Reddit listing pages fetched per poll                                                                                    |
| `SHIFT_EXPIRED_GRACE_DAYS`  |    Yes    | `1`                                    | integer (≥0)           | Grace period after expiry before codes are suppressed                                                                            |
| `SHIFT_LOG_CODES_VERBOSE`   |           | `true`                                 | boolean (`true/false`) | Emit categorized code lists to stdout                                                                                            |
| `REDIS_HOST`                |           | `redis`                                | string (hostname)      | Redis hostname inside the Docker network                                                                                        |
| `REDIS_PORT`                |    Yes    | `6379`                                 | integer (1-65535)      | Redis TCP port                                                                                                                   |
| `REDIS_TLS`                 |           | `false`                                | boolean                | Enable TLS for Redis socket                                                                                                     |
| `REDIS_USERNAME`            |           | *(empty)*                              | string                 | Redis ACL username if required                                                                                                  |
| `REDIS_PASSWORD`            |           | *secret*                               | string                 | Direct password override (prefer using secret)                                                                                   |
| `REDIS_PASSWORD_SECRET`     |           | `redis_password`                       | string                 | Name of Docker secret providing the Redis password                                                                               |

## Docker Secrets

> [!IMPORTANT]
> Secrets are consumed via Compose and mounted at `/run/secrets/<name>`. Populate each host secret file with the desired value before deployment.

| Secret Name             | Host Secret File Path                | Required | Description                                |
|-------------------------|---------------------------------------|:--------:|--------------------------------------------|
| `discord_webhook_url`   | `./secrets/discord_webhook_url.txt`   |   Yes    | Discord webhook target for notifications   |
| `redis_password`        | `./secrets/redis_password.txt`        |   Yes    | Password enforced by Redis authentication  |

## Ports

> [!NOTE]
> The app container does not expose ports; it communicates outbound to Reddit/Discord and inbound to Redis via the Docker bridge network.

| Service | Port        | Description                                               |
|---------|-------------|-----------------------------------------------------------|
| Redis   | `6379/tcp`  | Authenticated Redis instance backing deduplication state  |

## Volumes

| Volume        | Description                                                |
|---------------|------------------------------------------------------------|
| `redis-data`  | Persists Redis data (AOF/RDB) between container restarts   |

## Usage

### Docker Compose

Current [`docker-compose.yml`](./docker-compose.yml):

```yml
services:
  app:
    build: .
    user: "${APP_UID:-1000}:${APP_GID:-1000}"
    depends_on:
      - redis
    environment:
      NODE_ENV: production
      REDDIT_SUBREDDIT: "${REDDIT_SUBREDDIT:-borderlandsshiftcodes}"
      REDDIT_USER_AGENT: "${REDDIT_USER_AGENT:-BorderlandsSHiFTCodePublishing/1.0}"
      REDDIT_LOOKBACK_DAYS: "${REDDIT_LOOKBACK_DAYS:-30}"
      REDDIT_MAX_PAGES: "${REDDIT_MAX_PAGES:-6}"
      POLL_INTERVAL_MINUTES: "${POLL_INTERVAL_MINUTES:-120}"
      RETRY_ATTEMPTS: "${RETRY_ATTEMPTS:-4}"
      RETRY_BASE_DELAY_MS: "${RETRY_BASE_DELAY_MS:-2000}"
      REDIS_HOST: "${REDIS_HOST:-redis}"
      REDIS_PORT: "${REDIS_PORT:-6379}"
      REDIS_TLS: "${REDIS_TLS:-false}"
      REDIS_USERNAME: "${REDIS_USERNAME:-}"
      REDIS_PASSWORD_SECRET: "${REDIS_PASSWORD_SECRET:-redis_password}"
      DISCORD_WEBHOOK_SECRET: "${DISCORD_WEBHOOK_SECRET:-discord_webhook_url}"
      SHIFT_EXPIRED_GRACE_DAYS: "${SHIFT_EXPIRED_GRACE_DAYS:-1}"
      SHIFT_LOG_CODES_VERBOSE: "${SHIFT_LOG_CODES_VERBOSE:-true}"
    secrets:
      - discord_webhook_url
      - redis_password
    restart: unless-stopped

  redis:
    image: redis:7.4-alpine
    ports:
      - "6379:6379"
    # ...existing code...
    secrets:
      - redis_password

volumes:
  redis-data:

secrets:
  discord_webhook_url:
    file: ./secrets/discord_webhook_url.txt
  redis_password:
    file: ./secrets/redis_password.txt
```

### Deploy

```bash
docker compose pull         # optional if using prebuilt images
docker compose build        # build application container locally
docker compose up -d        # launch worker + redis
docker compose logs -f app  # tail worker activity and code discovery
```

### Local Development

```bash
npm install
REDIS_PASSWORD=local npm start
```

> [!TIP]
> For quick iteration, point `REDIS_HOST=127.0.0.1` and run `docker compose up redis` to reuse the stack’s Redis service while executing the worker directly on your machine.

## Operational Tips

- **Cooldown behavior**: long-lived codes resend monthly; set `SHIFT_EXPIRED_GRACE_DAYS` to `0` to suppress recently expired posts immediately.
- **Verbose diagnostics**: enable `SHIFT_LOG_CODES_VERBOSE=true` to categorize each parsed code and understand eligibility decisions.
- **Graceful shutdown**: `docker compose stop app` triggers signal handling so Redis connections close cleanly before exit.

## Additional Commands

| Purpose                 | Command                                     |
|-------------------------|---------------------------------------------|
| Force immediate poll    | `docker compose exec app pkill -USR1 node`  |
| Inspect Redis metadata  | `docker compose exec redis redis-cli --pass "$(cat /run/secrets/redis_password)" HGETALL shift:code:<CODE>` |

## Hooks & Extensibility

While the worker is intentionally single-purpose, you can extend behavior by submitting a pull request or forking the repo and:  
- Injecting alternate publication targets (e.g., Slack, web dashboard) in `publication-targets/`  
- Adding extra ingestion sources under `shift-code-sources/` with the same interface as `reddit.js`  
- Layering observability by wrapping `sendShiftNotification` with metrics or alerting logic

Stay tuned for roadmap updates as additional aggregation sources come online.
