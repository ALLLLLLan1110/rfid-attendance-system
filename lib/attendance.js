export const MIN_ACTION_INTERVAL_SECONDS = 10;

export function decideAttendanceAction(latestRecord, now = new Date(), minimumIntervalSeconds = MIN_ACTION_INTERVAL_SECONDS) {
  if (!latestRecord) return { action: 'check_in' };

  const lastActionAt = latestRecord.check_out_at || latestRecord.check_in_at;
  const elapsedMs = Math.max(0, now.getTime() - new Date(lastActionAt).getTime());
  const minimumMs = minimumIntervalSeconds * 1000;

  if (elapsedMs < minimumMs) {
    return {
      action: 'duplicate',
      retryAfterSeconds: Math.max(1, Math.ceil((minimumMs - elapsedMs) / 1000)),
    };
  }

  if (!latestRecord.check_out_at) {
    return {
      action: 'check_out',
      durationMinutes: Math.max(1, Math.ceil((now.getTime() - new Date(latestRecord.check_in_at).getTime()) / 60000)),
    };
  }

  return { action: 'check_in' };
}
