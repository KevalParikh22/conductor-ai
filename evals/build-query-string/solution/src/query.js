export function toQuery(params) {
  const parts = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') throw new TypeError(`${key}: nested objects are not supported`);
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
}
