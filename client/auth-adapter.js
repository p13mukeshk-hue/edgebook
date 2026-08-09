const GIS_SRC = 'https://accounts.google.com/gsi/client';

function normaliseUser(user) {
  if (!user || typeof user !== 'object') return null;
  const uid = user.uid || user.id || user.userId;
  const email = user.email || '';
  if (!uid || !email) return null;
  return {
    uid: String(uid),
    email: String(email),
    displayName: user.displayName || user.name || String(email).split('@')[0],
    photoURL: user.photoURL || user.picture || null,
    legacyFirebaseUid: user.legacyFirebaseUid ? String(user.legacyFirebaseUid) : null,
  };
}

function loadGoogleIdentityServices(timeoutMs = 12000) {
  if (globalThis.google?.accounts?.id) return Promise.resolve(globalThis.google.accounts.id);
  return new Promise((resolve, reject) => {
    let script = document.querySelector(`script[src="${GIS_SRC}"]`);
    const timer = setTimeout(() => reject(new Error('Google sign-in did not load')), timeoutMs);
    const done = () => {
      if (!globalThis.google?.accounts?.id) return;
      clearTimeout(timer);
      resolve(globalThis.google.accounts.id);
    };
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('Google sign-in could not be loaded'));
    };
    if (!script) {
      script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', fail, { once: true });
    done();
  });
}

function createVpsAdapter({ api, initialSession, googleClientId }) {
  let currentUser = normaliseUser(initialSession?.user);
  const listeners = new Set();
  let gis = null;
  let gisInitialised = false;

  api.setCsrfToken(initialSession?.csrfToken);

  const notify = () => listeners.forEach(fn => fn(currentUser));

  async function exchangeCredential(credential) {
    const result = await api.post('/auth/google', { credential });
    const user = normaliseUser(result?.user);
    if (!user) throw new Error('The Edgebook session response did not include a valid user');
    currentUser = user;
    notify();
    return { user };
  }

  async function initialiseGis(callback) {
    if (!googleClientId) throw new Error('Google sign-in is not configured on this server');
    gis = gis || await loadGoogleIdentityServices();
    if (!gisInitialised) {
      gis.initialize({
        client_id: googleClientId,
        callback: async response => {
          try {
            if (!response?.credential) throw new Error('Google did not return a credential');
            const result = await exchangeCredential(response.credential);
            callback?.(null, result);
          } catch (error) {
            callback?.(error);
          }
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      gisInitialised = true;
    }
    return gis;
  }

  return {
    mode: 'vps',
    initialUser: currentUser,
    onAuthStateChanged(callback) {
      listeners.add(callback);
      queueMicrotask(() => callback(currentUser));
      return () => listeners.delete(callback);
    },
    async mountGoogleButton(element, callback) {
      const identity = await initialiseGis(callback);
      element.replaceChildren();
      identity.renderButton(element, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        shape: 'rectangular',
        text: 'continue_with',
        width: Math.max(260, Math.round(element.getBoundingClientRect().width || 330)),
      });
      return true;
    },
    async signIn(callback) {
      const identity = await initialiseGis(callback);
      identity.prompt();
      return null;
    },
    async signOut() {
      await api.post('/auth/logout', {});
      if (currentUser?.email && gis?.disableAutoSelect) gis.disableAutoSelect();
      currentUser = null;
      notify();
    },
    getIdToken: async () => null,
  };
}

/**
 * Edgebook has one production identity/data authority: the VPS API. If its
 * capability or session bootstrap is unavailable, initialization fails closed
 * instead of activating a second writer.
 */
export async function createAuthAdapter({ api, config = {} }) {
  const serverConfig = await api.get('/config');
  if (serverConfig?.dataApiReady !== true) {
    throw new Error('VPS data API is not marked ready');
  }
  const session = await api.get('/auth/session');
  const googleClientId = config.googleClientId || serverConfig?.googleClientId || '';
  const adapter = createVpsAdapter({ api, initialSession: session, googleClientId });
  console.info('[auth] mode=vps');
  return adapter;
}
