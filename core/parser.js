import { parse } from 'chrono-node';

const CODE_REGEX =
  /\b[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}\b/g;
const EXPIRY_KEYWORDS =
  /(expire|expires|expiration|expiring|expiry|valid|until|deadline|redeem|use by|available)/i;
const TZ_TOKENS = /\b(?:UTC|GMT|PST|PDT|CST|CDT|EST|EDT|IST|BST|CET|CEST|PT)\b/gi;
const MONTH_MAP = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11
};
const MAX_EXPIRY_YEARS = 10;
const UNKNOWN_EXPIRY_WINDOW_HOURS = 48;
const CONTEXT_KEYWORDS =
  /(gold(?:en)? key|keys?|shift code|reward|multi platform|free)/i;
const CONTEXT_GLOBAL_FALLBACK_FLOOR = 2;

export function parseShiftCodes(posts) {
  const codes = new Map();

  for (const post of posts) {
    const combinedText = `${post.title}\n${post.body || ''}`;
    const matches = combinedText.match(CODE_REGEX);
    if (!matches) continue;

    for (const rawCode of matches) {
      const code = rawCode.toUpperCase();
      const context = extractContext(combinedText, code);
      let expiresAt = detectExpiration(
        combinedText,
        post.createdUtcMs,
        context
      );
      if (!expiresAt) {
        expiresAt = inferFallbackExpiration(post.createdUtcMs);
      }
      const entry = codes.get(code);

      if (entry) {
        entry.sources.add(post.permalink);

        const incomingCreated = Number.isFinite(post.createdUtcMs)
          ? post.createdUtcMs
          : null;
        const existingCreated = entry.createdAt?.getTime?.() ?? null;

        if (!entry.context && context) entry.context = context;
        if (!entry.expiresAt && expiresAt) entry.expiresAt = expiresAt;

        if (
          incomingCreated !== null &&
          (existingCreated === null || incomingCreated < existingCreated)
        ) {
          if (context) entry.context = context;
          if (expiresAt) entry.expiresAt = expiresAt;
          entry.postTitle = post.title;
          entry.permalink = post.permalink;
          entry.author = post.author;
          entry.createdAt = new Date(incomingCreated);
        }

        if (
          expiresAt &&
          (!entry.expiresAt || expiresAt < entry.expiresAt)
        ) {
          entry.expiresAt = expiresAt;
        }

        continue;
      }

      codes.set(code, {
        code,
        context,
        expiresAt,
        postTitle: post.title,
        permalink: post.permalink,
        author: post.author,
        createdAt: new Date(post.createdUtcMs),
        sources: new Set([post.permalink])
      });
    }
  }

  return Array.from(codes.values()).map((entry) => ({
    code: entry.code,
    context: entry.context,
    expiresAt: entry.expiresAt,
    postTitle: entry.postTitle,
    permalink: entry.permalink,
    author: entry.author,
    createdAt: entry.createdAt,
    sources: Array.from(entry.sources)
  }));
}

function extractContext(text, code) {
  const lines = text.split(/\r?\n/);
  const targetIndex = lines.findIndex((line) => line.includes(code));
  if (targetIndex === -1) return null;

  const candidates = [];
  const appendCandidate = (value) => {
    const normalized = value?.trim();
    if (normalized) candidates.push(normalized);
  };

  const line = lines[targetIndex];
  appendCandidate(line.replace(code, '').trim());

  for (let offset = 1; offset <= 6; offset += 1) {
    appendCandidate(lines[targetIndex - offset]);
  }
  for (let offset = 1; offset <= 2; offset += 1) {
    appendCandidate(lines[targetIndex + offset]);
  }

  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return null;

  let best = { value: unique[0], score: scoreContext(unique[0]) };
  for (const candidate of unique.slice(1)) {
    const score = scoreContext(candidate);
    if (score > best.score) {
      best = { value: candidate, score };
    }
  }

  if (best.score < CONTEXT_GLOBAL_FALLBACK_FLOOR) {
    const fallback = findGlobalContext(lines);
    if (fallback && fallback.score > best.score) {
      best = fallback;
    }
  }

  return best.value;
}

function scoreContext(value) {
  if (!value) return -Infinity;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  let score = 0;
  if (CONTEXT_KEYWORDS.test(trimmed)) score += 6;
  if (/[.!]$/.test(trimmed)) score += 2;
  if (trimmed.length >= 25) score += 3;
  else if (trimmed.length >= 10) score += 1;
  else if (trimmed.length <= 4) score -= 3;

  if (/^(bl4|multi platform)$/i.test(trimmed)) score -= 3;
  if (/^redeem\b/i.test(lower)) score -= 6;
  if (isLikelyCodeLine(trimmed)) score -= 12;
  if (/^[A-Z0-9]{2,6}$/.test(trimmed)) score -= 2;
  if (lower.includes('https://')) score -= 4;

  return score;
}

function findGlobalContext(lines) {
  let best = null;
  let bestScore = -Infinity;

  for (const raw of lines) {
    const candidate = raw?.trim();
    if (!candidate || isLikelyCodeLine(candidate)) continue;
    const score = scoreContext(candidate) - 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best ? { value: best, score: bestScore } : null;
}

function isLikelyCodeLine(text) {
  const matches = text.match(CODE_REGEX);
  if (!matches?.length) return false;
  const remainder = text.replace(CODE_REGEX, '').trim();
  return remainder.length === 0;
}

function detectExpiration(text, referenceUtcMs, context) {
  const reference = referenceUtcMs ? new Date(referenceUtcMs) : new Date();
  const segments = collectSegments(text, context);
  const candidates = [];

  for (const { value: rawSegment, forceParse } of segments) {
    const segment = sanitizeSegment(rawSegment);
    if (!segment) continue;

    const hasKeyword = EXPIRY_KEYWORDS.test(segment);
    if (hasKeyword) {
      const relative = extractRelativeExpiry(segment, reference);
      if (relative) candidates.push({ date: relative, weight: 3 });
    }

    if (forceParse || hasKeyword) {
      for (const explicit of extractExplicitDates(segment, reference)) {
        candidates.push({ date: explicit, weight: forceParse ? 3 : 2 });
      }
    }
  }

  return selectBestCandidate(candidates, reference);
}

function collectSegments(text, context) {
  if (!context) {
    return text.split(/\r?\n/).map((line) => ({ value: line, forceParse: false }));
  }

  const fragments = context
    .split(/[|•·\-–—:]/)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .map((fragment) => ({ value: fragment, forceParse: true }));

  const bodyLines = text
    .split(/\r?\n/)
    .map((line) => ({ value: line, forceParse: false }));

  return [
    ...fragments,
    { value: context, forceParse: true },
    ...bodyLines
  ];
}

function extractRelativeExpiry(segment, reference) {
  const hoursMatch = segment.match(/(\d+)\s*(?:hour|hr)s?/i);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (hours > 0 && hours <= 24 * 14) {
      return new Date(reference.getTime() + hours * 60 * 60 * 1000);
    }
  }

  const daysMatch = segment.match(/(\d+)\s*(?:day|d)\b/i);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    if (days > 0 && days <= 365) {
      return new Date(reference.getTime() + days * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}

function extractExplicitDates(segment, reference) {
  const normalized = normalizeDateTokens(segment);
  const unique = new Map();

  const manual = tryManualDate(normalized);
  if (manual) unique.set(manual.getTime(), manual);

  for (const result of parse(normalized, reference, { forwardDate: true })) {
    const candidate = result.start?.date();
    if (candidate) unique.set(candidate.getTime(), candidate);
  }

  return Array.from(unique.values());
}

function sanitizeSegment(segment) {
  return segment
    .replace(/[|~\[\]\(\)•·]/g, ' ')
    .replace(TZ_TOKENS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDateTokens(segment) {
  return segment
    .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.(?=\s)/gi, '$1')
    .replace(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{2})(?!\d)/gi,
      (_, day, month, year) => `${day} ${month} 20${year}`
    )
    .replace(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s*(\d{2})(?!\d)/gi,
      (_, month, day, year) => `${month} ${day}, 20${year}`
    );
}

function tryManualDate(segment) {
  const byDayFirst = segment.match(
    /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{2,4})/i
  );
  if (byDayFirst) {
    const [, day, month, year] = byDayFirst;
    return buildDate(toFourDigitYear(year), monthNameToIndex(month), day);
  }

  const byMonthFirst = segment.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s*(\d{2,4})/i
  );
  if (byMonthFirst) {
    const [, month, day, year] = byMonthFirst;
    return buildDate(toFourDigitYear(year), monthNameToIndex(month), day);
  }

  const iso = segment.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const [, year, month, day] = iso;
    return buildDate(Number(year), Number(month) - 1, day);
  }

  const slash = segment.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slash) {
    const [, month, day, year] = slash;
    return buildDate(toFourDigitYear(year), Number(month) - 1, day);
  }

  return null;
}

function buildDate(year, monthIndex, day) {
  if (
    !Number.isFinite(year) ||
    year < 1900 ||
    monthIndex == null ||
    monthIndex < 0 ||
    monthIndex > 11
  ) {
    return null;
  }
  const date = new Date(year, monthIndex, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toFourDigitYear(year) {
  const numeric = Number(year);
  if (!Number.isFinite(numeric)) return null;
  if (String(year).length === 4) return numeric;
  return numeric >= 70 ? 1900 + numeric : 2000 + numeric;
}

function monthNameToIndex(name) {
  if (!name) return null;
  const key = name.slice(0, 3).toLowerCase();
  return MONTH_MAP[key] ?? null;
}

function isPlausibleExpiration(date, reference) {
  if (date <= reference) return false;
  const max = new Date(reference);
  max.setFullYear(max.getFullYear() + MAX_EXPIRY_YEARS);
  return date <= max;
}

function selectBestCandidate(candidates, reference) {
  const valid = candidates.filter(({ date }) =>
    isPlausibleExpiration(date, reference)
  );
  if (!valid.length) return null;

  valid.sort((a, b) => b.weight - a.weight || a.date - b.date);
  return valid[0].date;
}

function inferFallbackExpiration(createdUtcMs) {
  if (!createdUtcMs) return null;
  return new Date(
    createdUtcMs + UNKNOWN_EXPIRY_WINDOW_HOURS * 60 * 60 * 1000
  );
}
