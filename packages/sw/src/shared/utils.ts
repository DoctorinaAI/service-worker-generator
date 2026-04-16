import { RETRY_BASE_DELAY_MS } from './constants';

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Normalize a URL to a resource key.
 * Strips query params, hashes, and trailing slashes.
 * Handles base URL and relative paths.
 */
export function getResourceKey(url: string, baseUrl?: string): string {
  try {
    const parsed = new URL(url, baseUrl ?? self.location.origin);
    let path = parsed.pathname;
    // Remove trailing slash (but keep root "/")
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    // Remove leading slash for consistency with manifest keys
    if (path.startsWith('/')) {
      path = path.slice(1);
    }
    // Root path maps to index.html
    return path || 'index.html';
  } catch {
    return url;
  }
}

/**
 * Calculate exponential backoff delay for a given attempt.
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @param baseDelay - Base delay in ms (default: RETRY_BASE_DELAY_MS)
 * @returns Delay in milliseconds with jitter
 */
export function backoffDelay(
  attempt: number,
  baseDelay = RETRY_BASE_DELAY_MS,
): number {
  const delay = baseDelay * Math.pow(2, attempt);
  // Add up to 20% jitter to prevent thundering herd
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
}

/**
 * Append a cache-busting query parameter to a URL.
 */
export function cacheBustUrl(url: string, hash: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${hash}`;
}
