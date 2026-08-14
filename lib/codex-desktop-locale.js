const I18N_LAYER_ID = '72216192';

function desktopLocaleBootstrapScript(language) {
  const locale = String(language || 'en-US');
  if (locale === 'en-US') return 'void 0;';
  return `(() => {
    const marker = Symbol.for('codex-navo.desktop-locale');
    const patch = () => {
      const instances = globalThis.__STATSIG__?.instances;
      if (!instances) return false;
      let changed = false;
      for (const client of Object.values(instances)) {
        if (!client || client[marker] || typeof client.getLayer !== 'function') continue;
        const getLayer = client.getLayer.bind(client);
        client.getLayer = (name, options) => {
          const layer = getLayer(name, options);
          if (name !== ${JSON.stringify(I18N_LAYER_ID)} || !layer || typeof layer.get !== 'function') return layer;
          const get = layer.get.bind(layer);
          layer.get = (key, fallback) => {
            if (key === 'enable_i18n') return true;
            if (key === 'locale_source') return 'IDE';
            return get(key, fallback);
          };
          return layer;
        };
        client[marker] = true;
        changed = true;
        try { client.$emt?.({ name: 'values_updated', status: client.loadingStatus }); } catch {}
      }
      return changed;
    };
    patch();
    const timer = setInterval(() => patch() && clearInterval(timer), 25);
    setTimeout(() => clearInterval(timer), 15000);
  })();`;
}

function openWebSocket(url, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Codex locale bridge connection timed out'));
    }, 3_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Codex locale bridge connection failed'));
    }, { once: true });
  });
}

function cdpCommand(socket, method, params, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Codex locale bridge ${method} timed out`)), 3_000);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (error) reject(error); else resolve(result);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.id !== id) return;
      if (message.error) finish(new Error(message.error.message || `${method} failed`));
      else finish(null, message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function applyDesktopLocaleBridge(port, language, options = {}) {
  if (language === 'en-US') return { applied: false, reason: 'english-default' };
  const fetchImpl = options.fetchImpl || fetch;
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const deadline = Date.now() + (options.timeoutMs || 10_000);
  let lastError = null;
  while (Date.now() < deadline) {
    let socket;
    try {
      const targets = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_500),
      }).then((response) => response.json());
      const target = targets.find((item) => item.type === 'page'
        && item.webSocketDebuggerUrl
        && String(item.url || '').startsWith('app://'));
      if (!target) throw new Error('Codex renderer is not ready');
      socket = await openWebSocket(target.webSocketDebuggerUrl, WebSocketImpl);
      const expression = desktopLocaleBootstrapScript(language);
      await cdpCommand(socket, 'Page.addScriptToEvaluateOnNewDocument', { source: expression }, 1);
      await cdpCommand(socket, 'Runtime.evaluate', { expression, returnByValue: true }, 2);
      socket.close();
      return { applied: true };
    } catch (error) {
      lastError = error;
      try { socket?.close(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError || new Error('Codex locale bridge timed out');
}

module.exports = { I18N_LAYER_ID, applyDesktopLocaleBridge, desktopLocaleBootstrapScript };
