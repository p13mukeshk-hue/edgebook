const pickArray = (payload, key) => Array.isArray(payload) ? payload : (payload?.[key] || []);

const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const serverManagedTradeFields = new Set([
  'version', 'updatedAt', 'createdAt', 'deletedAt', 'recordId', 'exact',
]);

const patchMatchesCurrentTrade = (current, fields) => Object.entries(fields || {}).every(([key, value]) =>
  serverManagedTradeFields.has(key) || stableJson(current?.[key]) === stableJson(value));

const isAmbiguousWriteError = error => error?.code === 'NETWORK_ERROR' ||
  error?.status === 409 || Number(error?.status) >= 500;

export function createVpsDataAdapter(api) {
  let settingsVersion = null;
  let settingsBaselineLoaded = false;
  let settingsWriteChain = Promise.resolve();
  const journalVersions = new Map();
  const journalEntries = new Map();
  const journalWriteChains = new Map();
  const versionHeaders = version => Number.isInteger(version) && version > 0
    ? { 'if-match': `"${version}"` }
    : {};

  return {
    mode: 'vps',
    settings: {
      async get() {
        const payload = await api.get('/settings');
        if (Number.isInteger(payload?.version)) settingsVersion = payload.version;
        settingsBaselineLoaded = true;
        return payload?.settings ?? payload ?? null;
      },
      put(settings) {
        const write = async () => {
          if (!settingsBaselineLoaded || !Number.isInteger(settingsVersion)) {
            const error = new Error('Settings must be reloaded before they can be changed safely');
            error.code = 'SETTINGS_BASELINE_REQUIRED';
            throw error;
          }
          const body = { settings, version: settingsVersion };
          try {
            const payload = await api.put('/settings', body);
            if (Number.isInteger(payload?.version)) settingsVersion = payload.version;
            return payload?.settings ?? payload ?? null;
          } catch (error) {
            // A timeout can happen after PostgreSQL committed. Re-read before
            // retrying: an identical remote value means the lost response was
            // actually successful; a different value is a real conflict.
            if (isAmbiguousWriteError(error)) {
              try {
                const latest = await api.get('/settings');
                if (Number.isInteger(latest?.version)) settingsVersion = latest.version;
                settingsBaselineLoaded = true;
                if (stableJson(latest?.settings ?? {}) === stableJson(settings)) {
                  return latest?.settings ?? settings;
                }
                error.latestSettings = latest?.settings ?? null;
                error.latestVersion = latest?.version ?? null;
              } catch {
                // Preserve the original write error when recovery cannot reach
                // the server either.
              }
            }
            throw error;
          }
        };
        const request = settingsWriteChain.then(write, write);
        settingsWriteChain = request.catch(() => undefined);
        return request;
      },
    },
    trades: {
      async list({ deleted = false, includeDeleted = false } = {}) {
        const baseQuery = new URLSearchParams({ limit: '500' });
        if (deleted) baseQuery.set('deleted', 'deleted');
        else if (includeDeleted) baseQuery.set('deleted', 'all');

        const trades = [];
        const seenCursors = new Set();
        let cursor = null;

        // A hard stop guards against a malformed server cursor turning startup
        // into an infinite request loop. At 500 rows per page this still allows
        // very large journals before surfacing an explicit error.
        for (let page = 0; page < 500; page += 1) {
          const query = new URLSearchParams(baseQuery);
          if (cursor) query.set('cursor', cursor);
          const payload = await api.get(`/trades?${query}`);
          trades.push(...pickArray(payload, 'trades'));

          const nextCursor = typeof payload?.nextCursor === 'string' && payload.nextCursor
            ? payload.nextCursor
            : null;
          if (!nextCursor) return trades;
          if (seenCursors.has(nextCursor)) {
            throw new Error('The Edgebook API returned a repeated trade cursor');
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        throw new Error('The Edgebook trade list exceeded the pagination safety limit');
      },
      create: trade => api.post('/trades', { trade }, {
        headers: trade?.id != null ? { 'idempotency-key': `trade:${trade.id}` } : {},
      }),
      async patch(id, fields) {
        const path = `/trades/${encodeURIComponent(id)}`;
        try {
          return await api.patch(path, { trade: fields }, { headers: versionHeaders(fields?.version) });
        } catch (error) {
          if (isAmbiguousWriteError(error)) {
            try {
              const latest = await api.get(path);
              const current = latest?.trade ?? latest;
              if (current && patchMatchesCurrentTrade(current, fields)) return { trade: current };
              error.latestTrade = current ?? null;
            } catch {
              // Keep the original mutation error if reconciliation also fails.
            }
          }
          throw error;
        }
      },
      softDelete: (id, version) => api.delete(`/trades/${encodeURIComponent(id)}`, {
        headers: versionHeaders(version),
      }),
      restore: (id, version) => api.post(`/trades/${encodeURIComponent(id)}/restore`, {}, {
        headers: versionHeaders(version),
      }),
      permanentDelete: (id, version) => api.delete(`/trades/${encodeURIComponent(id)}/permanent`, {
        headers: {
          ...versionHeaders(version),
          'x-confirm-permanent-delete': String(id),
        },
      }),
    },
    moods: {
      async list() {
        const payload = await api.get('/moods?limit=1000');
        return pickArray(payload, 'moods');
      },
      create: mood => api.post('/moods', { mood }, {
        headers: mood?.id != null ? { 'idempotency-key': `mood:${mood.id}` } : {},
      }),
      patch: (id, mood) => api.patch(`/moods/${encodeURIComponent(id)}`, { mood }),
      delete: id => api.delete(`/moods/${encodeURIComponent(id)}`),
    },
    journals: {
      async list(from, to) {
        const query = new URLSearchParams({ limit: '2000' });
        if (from) query.set('from', from);
        if (to) query.set('to', to);
        const payload = await api.get(`/journals?${query}`);
        const entries = pickArray(payload, 'entries');
        for (const journal of entries) {
          const date = journal?.date || journal?.id;
          if (date && Number.isInteger(journal?.version)) {
            journalVersions.set(String(date), journal.version);
            journalEntries.set(String(date), journal?.entry ?? null);
          }
        }
        return entries;
      },
      async get(date) {
        const payload = await api.get(`/journals/${encodeURIComponent(date)}`);
        const journal = payload?.journal ?? null;
        const key = String(date);
        if (journal && Number.isInteger(journal.version)) {
          journalVersions.set(key, journal.version);
          journalEntries.set(key, journal?.entry ?? null);
        } else {
          journalVersions.set(key, 0);
          journalEntries.set(key, null);
        }
        return journal?.entry ?? null;
      },
      state(date) {
        const key = String(date);
        return {
          known: journalEntries.has(key),
          version: journalVersions.get(key) ?? null,
          entry: journalEntries.get(key),
        };
      },
      put(date, entry) {
        const key = String(date);
        const write = async () => {
          if (!journalVersions.has(key)) {
            const currentPayload = await api.get(`/journals/${encodeURIComponent(date)}`);
            const current = currentPayload?.journal ?? null;
            if (current && Number.isInteger(current.version)) {
              journalVersions.set(key, current.version);
              journalEntries.set(key, current?.entry ?? null);
            } else {
              journalVersions.set(key, 0);
              journalEntries.set(key, null);
            }
          }
          const body = { entry };
          const version = journalVersions.get(key);
          if (Number.isInteger(version)) body.version = version;
          try {
            const payload = await api.put(`/journals/${encodeURIComponent(date)}`, body);
            const journal = payload?.journal ?? null;
            if (journal && Number.isInteger(journal.version)) {
              journalVersions.set(key, journal.version);
              journalEntries.set(key, journal?.entry ?? entry);
            }
            return journal?.entry ?? entry;
          } catch (error) {
            // A response can be lost after the journal UPSERT commits. Read the
            // canonical row before reporting failure so a retry cannot remain
            // permanently stuck on a stale optimistic-concurrency version.
            if (isAmbiguousWriteError(error)) {
              try {
                const latestPayload = await api.get(`/journals/${encodeURIComponent(date)}`);
                const latest = latestPayload?.journal ?? null;
                if (latest && Number.isInteger(latest.version)) {
                  journalVersions.set(key, latest.version);
                  journalEntries.set(key, latest?.entry ?? null);
                } else {
                  journalVersions.set(key, 0);
                  journalEntries.set(key, null);
                }
                if (latest && stableJson(latest.entry ?? {}) === stableJson(entry)) {
                  return latest.entry ?? entry;
                }
                error.latestJournal = latest?.entry ?? null;
                error.latestVersion = latest?.version ?? null;
              } catch {
                // Keep the original mutation error if reconciliation cannot
                // reach the server either. The durable browser dirty marker
                // will retry the entry on a later edit or app startup.
              }
            }
            throw error;
          }
        };
        const previous = journalWriteChains.get(key) || Promise.resolve();
        const request = previous.then(write, write);
        journalWriteChains.set(key, request.catch(() => undefined));
        return request;
      },
      async delete(date) {
        await (journalWriteChains.get(String(date)) || Promise.resolve());
        const result = await api.delete(`/journals/${encodeURIComponent(date)}`);
        journalVersions.delete(String(date));
        journalEntries.delete(String(date));
        journalWriteChains.delete(String(date));
        return result;
      },
    },
    notifications: {
      async list() {
        const payload = await api.get('/notifications?limit=500');
        return pickArray(payload, 'notifications');
      },
      create: notification => api.post('/notifications', { notification }),
      patch: (id, fields) => api.patch(`/notifications/${encodeURIComponent(id)}`, { notification: fields }),
      delete: id => api.delete(`/notifications/${encodeURIComponent(id)}`),
      readAll: () => api.post('/notifications/read-all', {}),
    },
    ctrader: {
      async config() {
        const payload = await api.get('/config');
        return { enabled: payload?.ctraderEnabled === true };
      },
      startOAuth: () => api.post('/ctrader/oauth/start', {}),
      pendingOAuth: () => api.get('/ctrader/oauth/pending'),
      async list() {
        const payload = await api.get('/ctrader/connections');
        return pickArray(payload, 'connections');
      },
      create: ({ grantId, ctidTraderAccountId, mappedLegacyAccountId = null, label = null }) =>
        api.post('/ctrader/connections', {
          grantId,
          ctidTraderAccountId,
          mappedLegacyAccountId: mappedLegacyAccountId || null,
          label: label?.trim() || null,
        }),
      status: id => api.get(`/ctrader/connections/${encodeURIComponent(id)}/status`),
      sync: id => api.post(`/ctrader/connections/${encodeURIComponent(id)}/sync`, {}),
      disconnect: id => api.post(`/ctrader/connections/${encodeURIComponent(id)}/disconnect`, {}),
    },
    screenshots: {
      async upload(tradeId, file) {
        const form = new FormData();
        form.append('file', file);
        return api.post(`/trades/${encodeURIComponent(tradeId)}/screenshots`, form);
      },
      delete: fileId => api.delete(`/files/${encodeURIComponent(fileId)}`),
      url: fileId => `/api/files/${encodeURIComponent(fileId)}`,
    },
    subscribe(onEvent, onError) {
      const events = new EventSource('/api/events', { withCredentials: true });
      events.onmessage = event => {
        try { onEvent?.(JSON.parse(event.data)); }
        catch (error) { onError?.(error); }
      };
      events.onerror = error => onError?.(error);
      return () => events.close();
    },
  };
}
