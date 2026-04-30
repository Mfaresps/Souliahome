// #region agent log
const DEBUG_ENDPOINT = 'http://127.0.0.1:7285/ingest/76d98979-170a-4e37-ae45-7d75cc90954a';
const DEBUG_SESSION_ID = '3f3afb';

export function debugLog(location: string, message: string, data: unknown): void {
  try {
    fetch(DEBUG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': DEBUG_SESSION_ID },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  } catch {
    /* swallow */
  }
}
// #endregion
