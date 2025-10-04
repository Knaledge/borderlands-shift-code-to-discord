import { createClient } from 'redis';

const SEEN_SET_KEY = 'shift:seen';
const CODE_HASH_PREFIX = 'shift:code:';

function codeKey(code) {
  return `${CODE_HASH_PREFIX}${code}`;
}

function toIso(timestamp) {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function deserializeMetadata(raw) {
  if (!raw || Object.keys(raw).length === 0) return null;
  return {
    firstSeenAt: parseDate(raw.first_seen),
    lastSentAt: parseDate(raw.last_sent_at),
    pendingRetry: raw.pending_retry === '1',
    lastErrorAt: parseDate(raw.last_error_at)
  };
}

export async function createStorage(redisConfig) {
  const client = createClient({
    socket: {
      host: redisConfig.host,
      port: redisConfig.port,
      tls: redisConfig.useTLS ? {} : undefined
    },
    username: redisConfig.username,
    password: redisConfig.password
  });

  client.on('error', (error) => {
    console.error('[redis] error', error);
  });

  await client.connect();

  return {
    async getCodeMetadata(codes) {
      if (!codes.length) return new Map();
      const multi = client.multi();
      codes.forEach((code) => multi.hGetAll(codeKey(code)));
      const replies = await multi.exec();
      const map = new Map();
      replies.forEach((raw, index) => {
        const code = codes[index];
        map.set(code, deserializeMetadata(raw));
      });
      return map;
    },

    async registerFirstSeen(codes, timestamp) {
      if (!codes.length) return;
      const iso = toIso(timestamp);
      const multi = client.multi();
      codes.forEach((code) => multi.hSetNX(codeKey(code), 'first_seen', iso));
      await multi.exec();
      await client.sAdd(SEEN_SET_KEY, codes);
    },

    async markSent(codes, timestamp) {
      if (!codes.length) return;
      const iso = toIso(timestamp);
      const multi = client.multi();
      codes.forEach((code) =>
        multi.hSet(codeKey(code), {
          last_sent_at: iso,
          pending_retry: '0'
        })
      );
      await multi.exec();
    },

    async markFailed(codes, timestamp) {
      if (!codes.length) return;
      const iso = toIso(timestamp);
      const multi = client.multi();
      codes.forEach((code) =>
        multi.hSet(codeKey(code), {
          pending_retry: '1',
          last_error_at: iso
        })
      );
      await multi.exec();
    },

    async close() {
      await client.quit();
    }
  };
}
