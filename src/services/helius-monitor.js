import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/addresses';
import { amountMatchesRange, payoutAmountRange, payoutExplorerUrl } from './payout-detection.js';

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOCKET_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;

export class SolanaMonitor {
  constructor({
    config,
    logger,
    onDetection,
    fetchImpl = globalThis.fetch,
    webSocketFactory = (url) => new globalThis.WebSocket(url),
  }) {
    this.rpcUrl = config.solanaPayoutRpcUrl;
    this.webSocketUrl = config.solanaPayoutWebSocketUrl;
    this.logger = logger;
    this.onDetection = onDetection;
    this.fetch = fetchImpl;
    this.webSocketFactory = webSocketFactory;
    this.watches = new Map();
    this.subscriptions = new Map();
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.socket = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.warned = new Set();
    this.retryAfter = new Map();
  }

  get enabled() {
    return Boolean(this.rpcUrl && this.webSocketUrl);
  }

  supports(blockchain) {
    return this.enabled && blockchain === 'sol';
  }

  async reconcile(entries) {
    if (!this.enabled) return;
    const activeIds = new Set(entries.map(({ swap }) => swap.id));
    for (const swapId of this.watches.keys()) {
      if (!activeIds.has(swapId)) this.removeWatch(swapId);
    }
    for (const swapId of this.retryAfter.keys()) {
      if (!activeIds.has(swapId)) this.retryAfter.delete(swapId);
    }
    for (const swapId of this.warned) {
      if (!activeIds.has(swapId)) this.warned.delete(swapId);
    }
    for (const entry of entries) {
      if (!this.watches.has(entry.swap.id)) await this.addWatch(entry.swap, entry.asset);
    }
    if (this.watches.size > 0) {
      this.ensureSocket();
      for (const watch of this.watches.values()) this.subscribe(watch);
    }
    if (this.watches.size === 0) this.closeSocket();
  }

  async addWatch(swap, asset) {
    if ((this.retryAfter.get(swap.id) ?? 0) > Date.now()) return false;
    const range = payoutAmountRange(swap);
    if (!range) return false;
    try {
      const token = Boolean(asset.contractAddress);
      const monitoredAddress = token
        ? await associatedTokenAddress(swap.recipient, asset.contractAddress)
        : address(swap.recipient);
      const baseline = await this.getBalance(monitoredAddress, token, 'confirmed');
      this.watches.set(swap.id, {
        swapId: swap.id,
        monitoredAddress: String(monitoredAddress),
        token,
        baseline,
        range,
        subscriptionId: null,
        checking: false,
      });
      this.warned.delete(swap.id);
      this.retryAfter.delete(swap.id);
      this.ensureSocket();
      this.subscribe(this.watches.get(swap.id));
      await this.checkWatch(this.watches.get(swap.id), null);
      return true;
    } catch (error) {
      this.retryAfter.set(swap.id, Date.now() + 60_000);
      if (!this.warned.has(swap.id)) {
        this.warned.add(swap.id);
        this.logger.warn({
          swapId: swap.id,
          blockchain: 'sol',
          errorCode: solanaErrorCode(error),
        }, 'Could not start processed Solana payout monitoring');
      }
      return false;
    }
  }

  removeWatch(swapId) {
    const watch = this.watches.get(swapId);
    if (!watch) return;
    if (watch.subscriptionId !== null) this.subscriptions.delete(watch.subscriptionId);
    this.watches.delete(swapId);
    this.warned.delete(swapId);
    this.retryAfter.delete(swapId);
  }

  ensureSocket() {
    if (this.stopped || this.socket || this.watches.size === 0) return;
    const socket = this.webSocketFactory(this.webSocketUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.startHeartbeat(socket);
      for (const watch of this.watches.values()) this.subscribe(watch);
    });
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.logger.warn({ errorCode: 'SOLANA_WEBSOCKET_ERROR' }, 'Solana payout monitor socket error');
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.resetSubscriptions();
      this.scheduleReconnect();
    });
  }

  subscribe(watch) {
    if (!watch || watch.subscriptionId !== null || this.socket?.readyState !== SOCKET_OPEN) return;
    const requestId = this.nextRequestId++;
    this.pendingRequests.set(requestId, watch.swapId);
    this.socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'logsSubscribe',
      params: [{ mentions: [watch.monitoredAddress] }, { commitment: 'processed' }],
    }));
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id != null) {
      const swapId = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      const watch = this.watches.get(swapId);
      if (watch && Number.isInteger(message.result)) {
        watch.subscriptionId = message.result;
        this.subscriptions.set(message.result, swapId);
      }
      return;
    }
    if (message.method !== 'logsNotification') return;
    const swapId = this.subscriptions.get(message.params?.subscription);
    const watch = this.watches.get(swapId);
    const signature = message.params?.result?.value?.signature;
    if (!watch || typeof signature !== 'string') return;
    void this.checkWatch(watch, signature);
  }

  async checkWatch(watch, signature) {
    if (!watch || watch.checking || !this.watches.has(watch.swapId)) return false;
    watch.checking = true;
    try {
      let current = await this.getBalance(watch.monitoredAddress, watch.token, 'processed');
      if (signature && current <= watch.baseline) {
        for (const delay of [100, 250, 500]) {
          await pause(delay);
          current = await this.getBalance(watch.monitoredAddress, watch.token, 'processed');
          if (current > watch.baseline) break;
        }
      }
      if (current > watch.baseline && amountMatchesRange(current - watch.baseline, watch.range)) {
        this.removeWatch(watch.swapId);
        await this.onDetection(watch.swapId, {
          provider: 'solana_processed',
          txHash: signature,
          explorerUrl: signature ? payoutExplorerUrl('sol', signature) : null,
        });
        return true;
      }
      watch.baseline = current;
      return false;
    } catch (error) {
      if (!this.warned.has(watch.swapId)) {
        this.warned.add(watch.swapId);
        this.logger.warn({
          swapId: watch.swapId,
          blockchain: 'sol',
          errorCode: solanaErrorCode(error),
        }, 'Could not check processed Solana payout balance');
      }
      return false;
    } finally {
      watch.checking = false;
    }
  }

  async getBalance(monitoredAddress, token, commitment) {
    const method = token ? 'getTokenAccountBalance' : 'getBalance';
    const response = await this.fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: [String(monitoredAddress), { commitment }],
      }),
      signal: globalThis.AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new SolanaRequestError(`SOLANA_HTTP_${response.status}`);
    const body = await response.json();
    if (body?.error) {
      if (token && /could not find account|invalid param/i.test(String(body.error.message ?? ''))) return 0n;
      throw new SolanaRequestError('SOLANA_RPC_ERROR');
    }
    const raw = token ? body?.result?.value?.amount : body?.result?.value;
    if (!/^\d+$/.test(String(raw ?? ''))) throw new SolanaRequestError('SOLANA_INVALID_RESPONSE');
    return BigInt(raw);
  }

  startHeartbeat(socket) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== SOCKET_OPEN) return;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'getHealth' }));
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  resetSubscriptions() {
    this.subscriptions.clear();
    this.pendingRequests.clear();
    for (const watch of this.watches.values()) watch.subscriptionId = null;
  }

  scheduleReconnect() {
    if (this.stopped || this.watches.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, 2_000);
    this.reconnectTimer.unref?.();
  }

  closeSocket() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    this.resetSubscriptions();
    socket?.close();
  }

  stop() {
    this.stopped = true;
    this.closeSocket();
    this.watches.clear();
  }
}

export async function associatedTokenAddress(owner, mint) {
  const encoder = getAddressEncoder();
  const [derived] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [
      encoder.encode(address(owner)),
      encoder.encode(address(TOKEN_PROGRAM)),
      encoder.encode(address(mint)),
    ],
  });
  return derived;
}

class SolanaRequestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SolanaRequestError';
    this.code = code;
  }
}

function solanaErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'SOLANA_RPC_UNAVAILABLE';
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
