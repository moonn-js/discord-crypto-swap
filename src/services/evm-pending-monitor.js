import { amountMatchesRange, evmBalanceOfData, parseRpcQuantity, payoutAmountRange } from './payout-detection.js';

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export class EvmPendingMonitor {
  constructor({ config, logger, onDetection, fetchImpl = globalThis.fetch }) {
    this.rpcUrls = config.evmPayoutRpcUrls;
    this.logger = logger;
    this.onDetection = onDetection;
    this.fetch = fetchImpl;
    this.warned = new Set();
    this.retryAfter = new Map();
  }

  supports(blockchain) {
    return Boolean(this.rpcUrls[blockchain]);
  }

  async poll(swap, asset) {
    const rpcUrl = this.rpcUrls[asset?.blockchain];
    if (!rpcUrl || !EVM_ADDRESS_PATTERN.test(String(swap?.recipient ?? ''))) return false;
    if ((this.retryAfter.get(swap.id) ?? 0) > Date.now()) return false;

    const request = balanceRequest(swap.recipient, asset);
    const range = payoutAmountRange(swap);
    if (!request || !range) return false;

    try {
      const [latest, pending] = await this.queryBalances(rpcUrl, request);
      this.warned.delete(swap.id);
      this.retryAfter.delete(swap.id);
      if (latest === null || pending === null || pending <= latest) return false;
      if (!amountMatchesRange(pending - latest, range)) return false;
      await this.onDetection(swap.id, { provider: `evm_pending_${asset.blockchain}` });
      return true;
    } catch (error) {
      this.retryAfter.set(swap.id, Date.now() + 30_000);
      if (!this.warned.has(swap.id)) {
        this.warned.add(swap.id);
        this.logger.warn({
          swapId: swap.id,
          blockchain: asset.blockchain,
          errorCode: errorCode(error),
        }, 'Could not check pending destination balance');
      }
      return false;
    }
  }

  forget(activeSwapIds) {
    for (const swapId of this.warned) {
      if (!activeSwapIds.has(swapId)) this.warned.delete(swapId);
    }
    for (const swapId of this.retryAfter.keys()) {
      if (!activeSwapIds.has(swapId)) this.retryAfter.delete(swapId);
    }
  }

  async queryBalances(rpcUrl, request) {
    const response = await this.fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: request.method, params: request.params('latest') },
        { jsonrpc: '2.0', id: 2, method: request.method, params: request.params('pending') },
      ]),
      signal: globalThis.AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new RpcRequestError(`EVM_RPC_HTTP_${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new RpcRequestError('EVM_RPC_INVALID_RESPONSE');
    const byId = new Map(body.map((entry) => [entry?.id, entry]));
    if (byId.get(1)?.error || byId.get(2)?.error) throw new RpcRequestError('EVM_RPC_ERROR');
    return [parseRpcQuantity(byId.get(1)?.result), parseRpcQuantity(byId.get(2)?.result)];
  }
}

function balanceRequest(recipient, asset) {
  if (!asset.contractAddress) {
    return {
      method: 'eth_getBalance',
      params: (block) => [recipient, block],
    };
  }
  if (!EVM_ADDRESS_PATTERN.test(asset.contractAddress)) return null;
  const data = evmBalanceOfData(recipient);
  if (!data) return null;
  return {
    method: 'eth_call',
    params: (block) => [{ to: asset.contractAddress, data }, block],
  };
}

class RpcRequestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RpcRequestError';
    this.code = code;
  }
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'EVM_RPC_UNAVAILABLE';
}
