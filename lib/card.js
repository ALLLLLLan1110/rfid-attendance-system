export function normalizeCardUid(value) {
  const uid = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  return /^(?:[0-9A-F]{2}){4,32}$/.test(uid) ? uid : null;
}
