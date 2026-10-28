export const DISCORD_PAGE_SIZE = 25;

export function paginate(items, requestedPage, pageSize = DISCORD_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(Number.parseInt(requestedPage, 10) || 0, 0), pageCount - 1);
  return {
    items: items.slice(page * pageSize, page * pageSize + pageSize),
    page,
    pageCount,
    hasPrevious: page > 0,
    hasNext: page < pageCount - 1,
  };
}

export function truncate(value, maximum) {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1))}…`;
}
