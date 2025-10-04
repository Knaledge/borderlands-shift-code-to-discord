const BASE_URL = 'https://www.reddit.com';

export async function fetchRecentPosts(config) {
  const cutoffUtcMs =
    Date.now() - config.reddit.lookbackDays * 24 * 60 * 60 * 1000;
  const posts = [];
  let after = null;

  for (let page = 0; page < config.reddit.maxPages; page += 1) {
    const url = buildListingUrl(config.reddit.subreddit, after);
    const payload = await fetchWithRetry(
      url,
      config.reddit.userAgent,
      config.retry
    );

    const children = payload?.data?.children ?? [];
    if (!children.length) break;

    let stop = false;
    for (const child of children) {
      const data = child.data;
      const createdUtcMs = data.created_utc * 1000;
      if (createdUtcMs < cutoffUtcMs) {
        stop = true;
        continue;
      }

      posts.push({
        id: data.id,
        title: data.title,
        body: data.selftext,
        permalink: `${BASE_URL}${data.permalink}`,
        author: data.author,
        createdUtcMs,
        url: data.url
      });
    }

    after = payload?.data?.after;
    if (stop || !after) break;
  }

  return posts;
}

function buildListingUrl(subreddit, after) {
  const params = new URLSearchParams({ limit: '100' });
  if (after) params.set('after', after);
  return `${BASE_URL}/r/${subreddit}/new.json?${params.toString()}`;
}

async function fetchWithRetry(url, userAgent, retryConfig, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json'
      }
    });

    if (response.status === 429) {
      const retryAfter =
        Number(response.headers.get('Retry-After')) * 1000 ||
        retryConfig.baseDelayMs * attempt;
      await delay(retryAfter);
      return fetchWithRetry(url, userAgent, retryConfig, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`Reddit responded with ${response.status}`);
    }

    return response.json();
  } catch (error) {
    if (attempt >= retryConfig.attempts) throw error;
    const backoff = retryConfig.baseDelayMs * attempt;
    await delay(backoff);
    return fetchWithRetry(url, userAgent, retryConfig, attempt + 1);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
