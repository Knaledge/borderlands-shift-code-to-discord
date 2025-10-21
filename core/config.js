import { readFile } from 'node:fs/promises';
import path from 'node:path';

const secretsDir = '/run/secrets';

async function readSecret(secretName) {
  if (!secretName) return null;
  try {
    const content = await readFile(path.join(secretsDir, secretName), 'utf8');
    return content.trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export async function loadConfig() {
  const discordWebhookUrl =
    process.env.DISCORD_WEBHOOK_URL ||
    (await readSecret(process.env.DISCORD_WEBHOOK_SECRET));
  if (!discordWebhookUrl) {
    throw new Error('Missing Discord webhook URL (env or secret).');
  }

  const redisPassword =
    process.env.REDIS_PASSWORD ||
    (await readSecret(process.env.REDIS_PASSWORD_SECRET));

  return {
    pollIntervalMinutes: toNumber(process.env.POLL_INTERVAL_MINUTES, 15),
    retry: {
      attempts: Math.max(1, toNumber(process.env.RETRY_ATTEMPTS, 4)),
      baseDelayMs: Math.max(250, toNumber(process.env.RETRY_BASE_DELAY_MS, 2000))
    },
    reddit: {
      subreddit: process.env.REDDIT_SUBREDDIT || 'Borderlandsshiftcodes',
      userAgent:
        process.env.REDDIT_USER_AGENT || 'PrototypeShiftBot/1.0',
      lookbackDays: Math.max(1, toNumber(process.env.REDDIT_LOOKBACK_DAYS, 7)),
      maxPages: Math.max(1, toNumber(process.env.REDDIT_MAX_PAGES, 6))
    },
    discord: {
      webhookUrl: discordWebhookUrl
    },
    redis: {
      host: process.env.REDIS_HOST || 'redis',
      port: toNumber(process.env.REDIS_PORT, 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: redisPassword || undefined,
      useTLS: toBoolean(process.env.REDIS_TLS, false)
    },
    expiredGraceDays: Math.max(
      0,
      toNumber(process.env.SHIFT_EXPIRED_GRACE_DAYS, 0)
    ),
    logCodeDetails: toBoolean(process.env.SHIFT_LOG_CODES_VERBOSE, false),
  };
}
