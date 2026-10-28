const SUPPORTED_CHAINS = new Set(['btc', 'ltc', 'doge']);

export class BlockCypherMonitor {
  constructor({ repositories, config, logger, fetchImpl = globalThis.fetch }) {
    this.repositories = repositories;
    this.token = config.blockCypherApiToken;
    this.callbackBaseUrl = config.payoutWebhookBaseUrl;
    this.webhookSecret = config.payoutWebhookSecret;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.inFlight = new Set();
    this.retryAfter = new Map();
  }

  get enabled() {
    return Boolean(this.token && this.callbackBaseUrl && this.webhookSecret);
  }

  supports(blockchain) {
    return this.enabled && SUPPORTED_CHAINS.has(blockchain);
  }

  async ensureRegistration(swap) {
    if (!this.supports(swap?.destination_blockchain)) return false;
    if (swap.payout_monitor_provider === 'blockcypher' && swap.payout_monitor_id) return true;
    if (swap.payout_monitor_id || this.inFlight.has(swap.id)) return false;
    if ((this.retryAfter.get(`create:${swap.id}`) ?? 0) > Date.now()) return false;

    this.inFlight.add(swap.id);
    try {
      const registrationId = await this.createRegistration(swap);
      const saved = await this.repositories.savePayoutMonitorRegistration(swap.id, 'blockcypher', registrationId);
      if (saved) {
        this.retryAfter.delete(`create:${swap.id}`);
        this.logger.info({ swapId: swap.id, blockchain: swap.destination_blockchain }, 'Unconfirmed payout webhook registered');
        return true;
      }
      await this.deleteRegistration(swap.destination_blockchain, registrationId);
      return false;
    } catch (error) {
      this.retryAfter.set(`create:${swap.id}`, Date.now() + 60_000);
      this.logger.warn({
        swapId: swap.id,
        blockchain: swap.destination_blockchain,
        errorCode: providerErrorCode(error),
      }, 'Could not register unconfirmed payout webhook');
      return false;
    } finally {
      this.inFlight.delete(swap.id);
    }
  }

  async removeRegistration(swap) {
    if (swap?.payout_monitor_provider !== 'blockcypher' || !swap.payout_monitor_id) return false;
    const retryKey = `delete:${swap.payout_monitor_id}`;
    if ((this.retryAfter.get(retryKey) ?? 0) > Date.now()) return false;
    try {
      await this.deleteRegistration(swap.destination_blockchain, swap.payout_monitor_id);
      await this.repositories.clearPayoutMonitorRegistration(swap.id, 'blockcypher', swap.payout_monitor_id);
      this.retryAfter.delete(retryKey);
      return true;
    } catch (error) {
      this.retryAfter.set(retryKey, Date.now() + 60_000);
      this.logger.warn({
        swapId: swap.id,
        blockchain: swap.destination_blockchain,
        errorCode: providerErrorCode(error),
      }, 'Could not remove unconfirmed payout webhook');
      return false;
    }
  }

  callbackPath(swapId) {
    return `/webhooks/blockcypher/${this.webhookSecret}/${swapId}`;
  }

  async createRegistration(swap) {
    const response = await this.request(
      `https://api.blockcypher.com/v1/${swap.destination_blockchain}/main/hooks`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'unconfirmed-tx',
          address: swap.recipient,
          url: new URL(this.callbackPath(swap.id), this.callbackBaseUrl).toString(),
          token: this.token,
        }),
      },
    );
    if (typeof response?.id !== 'string' || response.id.length < 8) {
      throw new ProviderRequestError('BLOCKCYPHER_INVALID_RESPONSE');
    }
    return response.id;
  }

  async deleteRegistration(blockchain, registrationId) {
    const url = new URL(`https://api.blockcypher.com/v1/${blockchain}/main/hooks/${encodeURIComponent(registrationId)}`);
    url.searchParams.set('token', this.token);
    await this.request(url.toString(), { method: 'DELETE' }, { allowEmpty: true, allowNotFound: true });
  }

  async request(url, options, { allowEmpty = false, allowNotFound = false } = {}) {
    let response;
    try {
      response = await this.fetch(url, { ...options, signal: globalThis.AbortSignal.timeout(10_000) });
    } catch {
      throw new ProviderRequestError('BLOCKCYPHER_UNAVAILABLE');
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new ProviderRequestError(`BLOCKCYPHER_HTTP_${response.status}`);
    if (allowEmpty && response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      if (allowEmpty) return null;
      throw new ProviderRequestError('BLOCKCYPHER_INVALID_RESPONSE');
    }
  }
}

class ProviderRequestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProviderRequestError';
    this.code = code;
  }
}

function providerErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'BLOCKCYPHER_ERROR';
}
