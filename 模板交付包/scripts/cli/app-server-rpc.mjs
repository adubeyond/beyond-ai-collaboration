import { redact } from './native-cli-runner.mjs';

// Node 24's built-in WebSocket accepts authenticated handshake headers. No custom wire protocol.
export async function connectAppServer(url, token, { onNotification = () => {}, onDisconnect = () => {}, timeoutMs = 15000 } = {}) {
  const address = new URL(url);
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || !token) throw new Error('Authenticated loopback app-server required');
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('App-server connection timeout')); }, timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('App-server connection rejected')); };
  });
  let next = 1, closed = false;
  const pending = new Map();
  const rejectAll = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
  socket.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      // Approval never does not mean silently answering interactive questions or authenticating plugins.
      if (message.method && 'id' in message) {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Use the attached native UI for interactive requests; no automatic approval broker' } }));
      } else if ('id' in message) {
        const call = pending.get(message.id); if (!call) return;
        pending.delete(message.id); clearTimeout(call.timer);
        message.error ? call.reject(new Error(redact(message.error.message ?? JSON.stringify(message.error)))) : call.resolve(message.result);
      } else onNotification(message);
    } catch (error) { rejectAll(error); onDisconnect(error); }
  };
  socket.onclose = () => { rejectAll(new Error('App-server disconnected; do not redispatch an unconfirmed turn')); if (!closed) onDisconnect(new Error('App-server disconnected')); };
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) return reject(new Error('App-server not connected'));
        const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} response unknown; inspect this session before retry`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
    },
    initialized() { socket.send(JSON.stringify({ method: 'initialized', params: {} })); },
    close() { closed = true; rejectAll(new Error('App-server client closed')); socket.close(); },
  };
}
