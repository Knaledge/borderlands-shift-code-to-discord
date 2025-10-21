import { loadConfig } from './config.js';
import { createStorage } from './storage.js';
import { fetchRecentPosts } from '../shift-code-sources/reddit.js';
import { parseShiftCodes } from './parser.js';
import {
  sendFailureNotification,
  sendShiftNotification
} from '../publication-targets/discord.js';

const LONG_TERM_THRESHOLD_MS = 32 * 24 * 60 * 60 * 1000;
const LONG_TERM_RESEND_MS = 30 * 24 * 60 * 60 * 1000;

async function main() {
  const config = await loadConfig();
  const storage = await createStorage(config.redis);

  let processing = false;

  const execute = async () => {
    if (processing) {
      console.warn('[worker] previous run still executing, skipping tick.');
      return;
    }

    processing = true;
    try {
      console.info('[worker] fetching subreddit posts...');
      const posts = await fetchRecentPosts(config);
      const parsedCodes = parseShiftCodes(posts);

      if (!parsedCodes.length) {
        console.info('[worker] no SHiFT codes found.');
        return;
      }

      const codeList = parsedCodes.map((entry) => entry.code);
      const metadataMap = await storage.getCodeMetadata(codeList);

      const now = new Date();
      const graceCutoff = config.expiredGraceDays
        ? new Date(
            now.getTime() - config.expiredGraceDays * 24 * 60 * 60 * 1000
          )
        : null;

      const stats = {
        totalParsed: parsedCodes.length,
        newlySeen: 0,
        expired: 0,
        retryEligible: 0,
        longTermEligible: 0,
        longTermThrottled: 0,
        shortTermEligible: 0,
        alreadySent: 0
      };

      const detail = {
        new: [],
        expired: [],
        retry_waiting: [],
        long_term_eligible: [],
        long_term_throttled: [],
        short_term_eligible: [],
        already_sent: []
      };

      const newlySeenCodes = new Set();
      const eligible = [];

      for (const entry of parsedCodes) {
        const metadata = metadataMap.get(entry.code);
        if (!metadata) {
          newlySeenCodes.add(entry.code);
          detail.new.push(entry.code);
        }

        if (isExpired(entry.expiresAt, now, graceCutoff)) {
          stats.expired += 1;
          detail.expired.push(describeExpiry(entry));
          continue;
        }

        const isLongTerm =
          entry.expiresAt &&
          entry.expiresAt.getTime() - now.getTime() >= LONG_TERM_THRESHOLD_MS;

        if (metadata?.pendingRetry) {
          eligible.push(entry);
          stats.retryEligible += 1;
          detail.retry_waiting.push(
            `${entry.code} last_error=${formatDate(metadata.lastErrorAt)}`
          );
          if (isLongTerm) {
            stats.longTermEligible += 1;
            detail.long_term_eligible.push(describeExpiry(entry));
          } else {
            stats.shortTermEligible += 1;
            detail.short_term_eligible.push(entry.code);
          }
          continue;
        }

        if (isLongTerm) {
          const lastSent = metadata?.lastSentAt;
          if (!lastSent || now.getTime() - lastSent.getTime() >= LONG_TERM_RESEND_MS) {
            eligible.push(entry);
            stats.longTermEligible += 1;
            detail.long_term_eligible.push(describeExpiry(entry));
          } else {
            stats.longTermThrottled += 1;
            detail.long_term_throttled.push(
              `${entry.code}@${formatDate(entry.expiresAt)} last_sent=${formatDate(lastSent)}`
            );
          }
          continue;
        }

        if (!metadata || !metadata.lastSentAt) {
          eligible.push(entry);
          stats.shortTermEligible += 1;
          detail.short_term_eligible.push(entry.code);
        } else {
          stats.alreadySent += 1;
          detail.already_sent.push(
            `${entry.code} last_sent=${formatDate(metadata.lastSentAt)}`
          );
        }
      }

      stats.newlySeen = newlySeenCodes.size;

      if (config.logCodeDetails) {
        logCodeDetailBuckets(detail);
      }

      if (!eligible.length) {
        console.info(
          `[worker] no codes eligible to announce (parsed=${stats.totalParsed}, new=${stats.newlySeen}, expired=${stats.expired}, retry_waiting=${stats.retryEligible}, long_term_throttled=${stats.longTermThrottled}, already_sent=${stats.alreadySent})`
        );
        return;
      }

      if (newlySeenCodes.size) {
        await storage.registerFirstSeen(Array.from(newlySeenCodes), now);
      }

      const pendingCodes = new Set(eligible.map((entry) => entry.code));
      const timestampIso = now.toISOString();

      try {
        console.info(
          `[worker] announcing ${eligible.length} code(s) (short_term=${stats.shortTermEligible}, long_term=${stats.longTermEligible}, retry=${stats.retryEligible})`
        );
        await sendShiftNotification(
          config.discord.webhookUrl,
          eligible,
          config.retry,
          async (chunk) => {
            const chunkCodes = chunk.map((entry) => entry.code);
            await storage.markSent(chunkCodes, timestampIso);
            chunkCodes.forEach((code) => pendingCodes.delete(code));
          }
        );

        if (pendingCodes.size) {
          await storage.markSent(Array.from(pendingCodes), timestampIso);
          pendingCodes.clear();
        }

        console.info(`[worker] announced ${eligible.length} code(s).`);
      } catch (error) {
        if (pendingCodes.size) {
          await storage.markFailed(Array.from(pendingCodes), timestampIso);
        }
        throw error;
      }
    } catch (error) {
      console.error('[worker] run failed', error);
      try {
        await sendFailureNotification(
          config.discord.webhookUrl,
          error,
          config.retry
        );
      } catch (discordError) {
        console.error('[worker] failed to report failure to Discord', discordError);
      }
    } finally {
      processing = false;
    }
  };

  await execute();
  const intervalMs = config.pollIntervalMinutes * 60 * 1000;
  const timer = setInterval(execute, intervalMs);

  const shutdown = async (signal) => {
    console.info(`[worker] received ${signal}, shutting down.`);
    clearInterval(timer);
    try {
      await storage.close();
    } finally {
      process.exit(0);
    }
  };

  ['SIGTERM', 'SIGINT'].forEach((signal) =>
    process.on(signal, () => shutdown(signal))
  );
}

main().catch((error) => {
  console.error('[worker] fatal initialization error', error);
  process.exit(1);
});

function isExpired(expiresAt, now, graceCutoff) {
  if (!expiresAt) return false;
  if (expiresAt > now) return false;
  return !graceCutoff || expiresAt < graceCutoff;
}

function describeExpiry(entry) {
  return `${entry.code}@${formatDate(entry.expiresAt)}`;
}

function formatDate(value) {
  if (!value) return 'n/a';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString();
}

function logCodeDetailBuckets(detail) {
  const sections = [
    ['new', detail.new],
    ['expired', detail.expired],
    ['retry_waiting', detail.retry_waiting],
    ['long_term_eligible', detail.long_term_eligible],
    ['long_term_throttled', detail.long_term_throttled],
    ['short_term_eligible', detail.short_term_eligible],
    ['already_sent', detail.already_sent]
  ];
  sections.forEach(([label, list]) => {
    if (list.length) {
      console.info(`[worker] codes.${label}: ${list.join(', ')}`);
    }
  });
}
