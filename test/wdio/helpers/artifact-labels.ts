export function safeArtifactLabel(
  label: string,
  fallback = 'artifact',
  maxLength = 80,
): string {
  const clean = (value: string) => value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, maxLength)
    .replace(/^-+|-+$/g, '')

  const safe = clean(label)
  if (safe.length > 0) {
    return safe
  }

  const safeFallback = clean(fallback)
  return safeFallback.length > 0 ? safeFallback : 'artifact'
}
