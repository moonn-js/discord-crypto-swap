import { z } from 'zod';

const assetSchema = z.object({
  assetId: z.string().min(1).max(100),
  blockchain: z.string().min(1).max(40),
  symbol: z.string().min(1).max(40),
  decimals: z.number().int().min(0).max(255),
  contractAddress: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]).nullable().optional(),
  priceUpdatedAt: z.string().nullable().optional(),
});

export class AssetCatalogue {
  constructor({ repositories, oneClick, health, logger, refreshMs }) {
    this.repositories = repositories;
    this.oneClick = oneClick;
    this.health = health;
    this.logger = logger;
    this.refreshMs = refreshMs;
    this.assets = new Map();
    this.timer = null;
  }

  async initialize() {
    const cached = await this.repositories.listActiveAssets();
    this.replaceMemoryCache(cached);

    try {
      await this.refresh();
    } catch (error) {
      this.logger.warn({ errorCode: this.oneClick.errorCode(error) }, 'Live asset refresh failed; using persisted catalogue');
      if (this.assets.size === 0) throw error;
    }

    this.health.assets = this.assets.size > 0;
    this.timer = setInterval(() => {
      this.refresh().catch((error) => {
        this.logger.warn({ errorCode: this.oneClick.errorCode(error) }, 'Scheduled asset refresh failed');
      });
    }, this.refreshMs);
    this.timer.unref?.();
  }

  async refresh() {
    const response = await this.oneClick.getTokens();
    const parsed = z.array(assetSchema).parse(response);
    await this.repositories.replaceAssetCatalogue(parsed);
    this.replaceMemoryCache(parsed);
    this.health.assets = true;
    this.logger.info({ assetCount: parsed.length, chainCount: this.getChains().length }, 'Supported asset catalogue refreshed');
  }

  replaceMemoryCache(assets) {
    this.assets = new Map(assets.map((asset) => [asset.assetId, { ...asset, decimals: Number(asset.decimals) }]));
  }

  getAsset(assetId) {
    return this.assets.get(assetId) ?? null;
  }

  getAssets() {
    return [...this.assets.values()];
  }

  getChains() {
    return [...new Set([...this.assets.values()].map((asset) => asset.blockchain))].sort((a, b) => a.localeCompare(b));
  }

  getAssetsForChain(blockchain, excludeAssetId = null) {
    return [...this.assets.values()]
      .filter((asset) => asset.blockchain === blockchain && asset.assetId !== excludeAssetId)
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.assetId.localeCompare(b.assetId));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
