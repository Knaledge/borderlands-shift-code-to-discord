const SHIFT_REDEEM_URL = 'https://shift.gearboxsoftware.com/rewards';
const GOLDEN_KEY_CONTEXT_LABEL = 'Golden Key(s)';
const GOLDEN_KEY_PATTERN = /\bgold(?:en)?\b.*\bkey\b|\bkey\b.*\bgold(?:en)?\b/i;
const EMBED_SEPARATOR = '~~---------------------~~';

export async function sendShiftNotification(
  webhookUrl,
  codes,
  retryConfig,
  onChunkSuccess
) {
  const afterChunk = onChunkSuccess ?? (() => {});
  const chunks = chunkArray(codes, 25);
  for (const chunk of chunks) {
    const payload = buildEmbedPayload(chunk);
    await postWithRetry(webhookUrl, payload, retryConfig);
    await afterChunk(chunk);
  }
}

export async function sendFailureNotification(
  webhookUrl,
  error,
  retryConfig
) {
  const payload = {
    embeds: [
      {
        title: 'SHiFT code fetch failed',
        description: `\`\`\`\n${truncate(error?.stack || String(error), 3500)}\n\`\`\``,
        color: 0xff4d4d,
        timestamp: new Date().toISOString()
      }
    ]
  };
  await postWithRetry(webhookUrl, payload, retryConfig);
}

function buildEmbedPayload(codes) {
  const groups = groupCodesBySource(codes);
  return {
    embeds: [
      {
        title: `Latest Borderlands 4 SHiFT Codes`,
        color: 0xf40313,
        timestamp: new Date().toISOString(),
        fields: buildGroupFields(groups),
        footer: {
          text: 'Data sourced from r/borderlandsshiftcodes'
        }
      }
    ],
    components: buildComponents(groups)
  };
}

function buildGroupFields(groups) {
  return groups.slice(0, 25).map((group, index) => {
    const consolidated = groupEntriesByMeta(group.entries);
    const sections = consolidated.map(formatMetaSection);
    const links = [
      group.source ? `[Source](${group.source})` : null,
      `[Redeem](${SHIFT_REDEEM_URL})`
    ]
      .filter(Boolean)
      .join(' • ');
    const valueParts = [];
    sections.forEach((section, sectionIndex) => {
      valueParts.push(section);
      if (sectionIndex < sections.length - 1) {
        valueParts.push(EMBED_SEPARATOR);
      }
    });
    valueParts.push('');
    valueParts.push(links);
    if (index < groups.length - 1) {
      valueParts.push('');
      valueParts.push(EMBED_SEPARATOR);
    }
    return {
      name: '\u200b',
      value: valueParts.join('\n'),
      inline: false
    };
  });
}

function groupEntriesByMeta(entries) {
  const map = new Map();
  for (const entry of entries) {
    const { key: contextKey, display: contextDisplay } = canonicalizeContext(
      entry.context
    );
    const expiresKey = entry.expiresAt
      ? entry.expiresAt.getTime().toString()
      : 'null';
    const key = `${contextKey}|${expiresKey}`;
    if (!map.has(key)) {
      map.set(key, {
        contextKey,
        context: contextDisplay,
        expiresAt: entry.expiresAt || null,
        codes: []
      });
    }
    map.get(key).codes.push(entry);
  }
  return Array.from(map.values());
}

function formatMetaSection(group) {
  const codeBlocks = group.codes
    .map((entry) => `\`\`\`${entry.code}\`\`\``)
    .join('\n');
  const contextLine = group.context
    ? `**Context:** ${group.context}`
    : null;
  const expiresLine = group.expiresAt
    ? `**Expires:** ${formatExpiresLine(group.expiresAt)}`
    : '**Expires:** Unknown';
  return [contextLine, expiresLine, codeBlocks].filter(Boolean).join('\n\n');
}

function formatExpiresLine(date) {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function groupCodesBySource(codes) {
  const map = new Map();
  for (const entry of codes) {
    const key = entry.permalink || 'unknown';
    if (!map.has(key)) {
      map.set(key, {
        source: entry.permalink || null,
        author: entry.author || '',
        entries: []
      });
    }
    map.get(key).entries.push(entry);
  }
  return Array.from(map.values());
}

function buildComponents(groups) {
  const rows = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'Redeem',
          url: SHIFT_REDEEM_URL
        }
      ]
    }
  ];

  const sourceButtons = groups
    .map((group, index) => {
      if (!group.source) return null;
      return {
        type: 2,
        style: 5,
        label: groups.length === 1 ? 'Source' : `Source ${index + 1}`,
        url: group.source
      };
    })
    .filter(Boolean);

  const remainingRows = 5 - rows.length;
  chunkArray(sourceButtons, 5)
    .slice(0, remainingRows)
    .forEach((segment) =>
      rows.push({
        type: 1,
        components: segment
      })
    );

  return rows;
}

async function postWithRetry(webhookUrl, payload, retryConfig, attempt = 1) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const waitMs =
        Math.ceil((body.retry_after ?? 1) * 1000) ||
        retryConfig.baseDelayMs * attempt;
      await delay(waitMs);
      return postWithRetry(webhookUrl, payload, retryConfig, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord responded with ${response.status}: ${text}`);
    }
  } catch (error) {
    if (attempt >= retryConfig.attempts) throw error;
    const backoff = retryConfig.baseDelayMs * attempt;
    await delay(backoff);
    return postWithRetry(webhookUrl, payload, retryConfig, attempt + 1);
  }
}

function chunkArray(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalizeContext(rawContext) {
  if (!rawContext) {
    return { key: 'null', display: null };
  }
  const trimmed = rawContext.trim();
  if (isGoldenKeyContext(trimmed)) {
    return { key: 'golden_key', display: GOLDEN_KEY_CONTEXT_LABEL };
  }
  return { key: trimmed.toLowerCase(), display: trimmed };
}

function isGoldenKeyContext(value) {
  return GOLDEN_KEY_PATTERN.test(value);
}
