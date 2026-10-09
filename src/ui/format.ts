export const tabsLabel = (count: number): string => (count === 0 ? 'No tabs' : count === 1 ? '1 tab' : `${count} tabs`);

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "github.com" for an address; empty for pages that are not http(s). */
export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : '';
  } catch {
    return '';
  }
}

export const isWebUrl = (url: string | undefined): boolean => !!url && /^https?:\/\//i.test(url);
