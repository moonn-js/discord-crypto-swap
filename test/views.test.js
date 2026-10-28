import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  closeConfirmationPayload,
  completedDealComponents,
  completedDealEmbed,
  depositSpeedupPayload,
  panelPayload,
  payoutClosingPayload,
  payoutSentPayload,
  renderTicket,
  statusUpdateEmbed,
  statusUpdatePayload,
  supportedCoinsPayload,
  ticketHeaderPayload,
} from '../src/discord/views.js';
import { CoinPolicy } from '../src/services/coin-policy.js';

const assets = [
  entry('BTC', 'btc', 'nep141:btc.omft.near', 8),
  entry('ETH', 'eth', 'nep141:eth.omft.near', 18),
  entry('ETH', 'arb', 'nep141:arb.omft.near', 18),
  entry('ETH', 'base', 'nep141:base.omft.near', 18),
  entry('ETH', 'op', 'nep245:v2_1.omni.hot.tg:10_11111111111111111111', 18),
  entry('LTC', 'ltc', 'nep141:ltc.omft.near', 8),
  entry('USDC', 'eth', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', 6),
  entry('USDC', 'bsc', 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r', 18),
  entry('USDC', 'sol', 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', 6),
  entry('AVAX', 'avax', 'nep245:v2_1.omni.hot.tg:43114_11111111111111111111', 18),
];
const catalogue = {
  getAssets: () => assets,
  getAsset: (id) => assets.find((asset) => asset.assetId === id) ?? null,
};
const policy = new CoinPolicy(catalogue);
const emojis = { get: () => '🔹' };
const config = { slippageBps: 50 };

function serialize(payload) {
  return {
    embeds: (payload.embeds ?? []).map((embed) => typeof embed.toJSON === 'function' ? embed.toJSON() : embed),
    components: payload.components.map((component) => component.toJSON()),
    flags: payload.flags,
  };
}

describe('coin-first ticket component views', () => {
  it('renders the exact swap panel copy and keeps supported coins enabled during an outage', () => {
    const available = serialize(panelPayload());
    expect(available.embeds[0]).toMatchObject({
      title: 'Crypto-to-Crypto Swap',
      description: 'Open a ticket to swap between supported coins in just a few minutes for a **0% service fee**.',
      fields: [{
        name: 'How it works',
        value: 'Choose your coins and networks → enter an amount and wallet addresses → review the quote → deposit from your own wallet → track delivery.',
      }],
      footer: { text: 'One open swap ticket per member' },
    });
    expect(available.components[0].components.map((button) => button.custom_id)).toEqual([
      'panel:start',
      'panel:supported-coins',
    ]);
    expect(available.components[0].components.map((button) => button.label)).toEqual([
      'Start swap',
      'Supported Coins',
    ]);

    const disabled = serialize(panelPayload(true));
    expect(disabled.components[0].components[0]).toMatchObject({ disabled: true, label: 'Temporarily unavailable' });
    expect(disabled.components[0].components[1].disabled).not.toBe(true);
  });

  it('lists only live curated coins and networks in the supported-coins response', () => {
    const payload = serialize(supportedCoinsPayload(policy));
    const text = JSON.stringify(payload.embeds[0]);
    expect(text).toContain('Individual route availability is confirmed when your ticket quote is created.');
    expect(text).toContain('**BTC** — Bitcoin');
    expect(text).toContain('**ETH** — Ethereum, Arbitrum, Base, Optimism');
    expect(text).toContain('**AVAX** — Avalanche');
    expect(text).not.toContain('**SOL**');
  });

  it('keeps the destructive close control in a dedicated ticket header', () => {
    const ticketId = randomUUID();
    const header = serialize(ticketHeaderPayload(ticketId));
    expect(header.embeds[0].title).toBe('Private swap controls');
    expect(header.components[0].components.map((button) => button.label)).toEqual(['Close ticket']);

    const confirmation = serialize(closeConfirmationPayload(ticketId, true));
    expect(confirmation.embeds[0].title).toBe('Close this ticket?');
    expect(confirmation.embeds[0].description).toContain('does not cancel the swap');
    expect(confirmation.components[0].components.map((button) => button.label)).toEqual(['Close ticket', 'Keep ticket open']);
  });

  it('renders featured coins in policy order with Other last and an emoji on every option', () => {
    const payload = renderTicket(
      { id: randomUUID(), step: 'ORIGIN_COIN', state_data: {} },
      catalogue,
      null,
      config,
      policy,
      emojis,
    );
    const serialized = serialize(payload);
    const container = serialized.components[0];
    const popularButtons = container.components[1].components;
    const options = container.components[2].components[0].options;
    expect(serialized.flags).toBe(32_768);
    expect(serialized.embeds).toEqual([]);
    expect(options.map((option) => option.label)).toEqual(['BTC', 'ETH', 'LTC', 'USDC', 'Other']);
    expect(options.every((option) => option.emoji?.name)).toBe(true);
    expect(container.components[0].content).toContain('Popular picks');
    expect(popularButtons.map((button) => button.label)).toEqual([
      'LTC → USDT (BEP-20)',
      'USDT (BEP-20) → LTC',
      'LTC → USDT (ERC-20)',
    ]);
  });

  it('renders only the approved networks for a multi-network coin', () => {
    const payload = renderTicket({
      id: randomUUID(),
      step: 'ORIGIN_NETWORK',
      state_data: { originCoin: 'ETH', originCoinGroup: 'featured' },
    }, catalogue, null, config, policy, emojis);
    const options = serialize(payload).components[0].components[0].options;
    expect(options.map((option) => option.label)).toEqual(['Ethereum', 'Arbitrum', 'Base', 'Optimism']);
  });

  it('asks for the USD amount and addresses in ticket chat without modal controls', () => {
    const amountTicket = {
      id: randomUUID(),
      step: 'USD_AMOUNT',
      state_data: {
        originAssetId: assets[5].assetId,
        destinationAssetId: assets[6].assetId,
      },
    };
    const amount = serialize(renderTicket(amountTicket, catalogue, null, config, policy, emojis));
    expect(amount.embeds[0].description).toContain('Type the USD value');
    expect(amount.embeds[0].description).toContain('Example: **25**');
    expect(amount.embeds[0].description).not.toContain('Example: **$25**');
    expect(amount.embeds[0].fields.some((field) => field.name === 'Estimated current limits')).toBe(false);
    expect(amount.components[0].components.map((button) => button.label)).toEqual(['Back']);
    expect(amount.embeds[0]).not.toHaveProperty('footer');

    const addressTicket = {
      ...amountTicket,
      step: 'RECIPIENT_ADDRESS',
      state_data: {
        ...amountTicket.state_data,
        amountUsdRequested: '25.00',
        amountDisplay: '0.25',
        rememberedRecipientAddress: `0x${'a'.repeat(40)}`,
        rememberedRefundAddress: 'ltc-last-address',
      },
    };
    const address = serialize(renderTicket(addressTicket, catalogue, null, config, policy, emojis));
    expect(address.embeds[0].description).toContain('Type **`yes`** to reuse your last Ethereum address');
    expect(address.embeds[0].description).toContain(`0x${'a'.repeat(40)}`);
    expect(address.embeds[0].description).toContain('Ethereum');

    const refund = serialize(renderTicket({ ...addressTicket, step: 'REFUND_ADDRESS' }, catalogue, null, config, policy, emojis));
    expect(refund.embeds[0].title).toBe('Refund address required — Litecoin');
    expect(refund.embeds[0].description).toContain('## Send your Litecoin refund address below');
    expect(refund.embeds[0].description).toContain('Type **`yes`** to reuse your last Litecoin address');
    expect(refund.embeds[0].description).toContain('ltc-last-address');
  });

  it('renders executable memo instructions and private controls', () => {
    const ticket = { id: randomUUID(), step: 'ACTIVE', state_data: {}, progress_message_id: 'progress' };
    const swap = {
      status: 'PENDING_DEPOSIT',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      recipient: 'recipient',
      refund_to: 'refund',
      deposit_address: 'deposit-address',
      deposit_memo: '12345',
      qr_message_id: 'progress',
      quote_deadline: new Date(Date.now() + 60_000),
      executable_quote: {
        quoteRequest: { appFees: [{ recipient: 'fee-recipient.near', fee: 12 }] },
        quote: {
          amountInFormatted: '1',
          amountInUsd: '100',
          amountOutFormatted: '2',
          amountOutUsd: '99.70',
          timeEstimate: 120,
        },
      },
    };
    const json = serialize(renderTicket(ticket, catalogue, swap, config, policy, emojis));
    expect(json.embeds[0].fields.some((field) => field.name === 'Memo')).toBe(true);
    expect(json.components[0].components.map((button) => button.label)).toEqual(['Check status', 'Copy details']);
    expect(json.embeds[0].title).toBe('📤 Send your swap');
    expect(json.embeds[0].description).toContain('to the address below');
    expect(json.embeds[0].fields).toContainEqual(expect.objectContaining({ name: 'Network + Spread fee', value: expect.stringContaining('0.18%') }));
    expect(json.embeds[0].fields.some((field) => field.name === 'Bot fee')).toBe(false);
    expect(json.embeds[0].fields.some((field) => field.name.includes('provider fee'))).toBe(false);
    expect(json.embeds[0].fields.some((field) => field.name === 'Estimated time')).toBe(false);
    expect(json.embeds[0].fields.some((field) => field.name.includes('Speed up deposit detection'))).toBe(false);
    const speedup = serialize(depositSpeedupPayload(swap));
    expect(speedup.embeds[0].title).toBe('⚡ Speed up deposit detection (optional)');
    expect(speedup.embeds[0].description).toContain('transaction ID (txid)');
    expect(json.embeds[0].thumbnail.url).toBe('attachment://deposit-address.png');
    expect(json.embeds[0]).not.toHaveProperty('footer');

    const terminal = serialize(renderTicket(ticket, catalogue, {
      ...swap,
      status: 'SUCCESS',
      last_status_response: {
        swapDetails: {
          depositedAmountFormatted: '0.998',
          amountOutFormatted: '1.975',
        },
      },
    }, config, policy, emojis));
    expect(terminal.components[0].components.map((button) => button.label)).toEqual(['Close ticket']);
    expect(terminal.embeds[0].fields).toContainEqual(expect.objectContaining({ name: 'Deposited', value: '`0.998 LTC`' }));
    expect(terminal.embeds[0].fields).toContainEqual(expect.objectContaining({ name: 'You received', value: expect.stringContaining('1.975 USDC') }));
    expect(terminal.embeds[0].fields.find((field) => field.name === 'You received').value).not.toContain('~');
    expect(terminal.embeds[0].fields.some((field) => field.name === 'Estimated time')).toBe(false);
  });

  it('shows when a deposit transaction ID has already been submitted', () => {
    const swap = {
      status: 'PENDING_DEPOSIT',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      recipient: 'recipient',
      deposit_address: 'deposit-address',
      deposit_tx_hash: 'a'.repeat(64),
      quote_deadline: new Date(Date.now() + 60_000),
      executable_quote: { quote: { amountInFormatted: '1', amountOutFormatted: '2' } },
    };

    const json = serialize(depositSpeedupPayload(swap));
    expect(json.embeds[0].title).toBe('✅ Transaction ID submitted');
    expect(json.embeds[0].description).toContain('provider has been notified');
  });

  it('renders a privacy-safe completed-deal summary with fees', () => {
    const swap = {
      id: randomUUID(),
      status: 'SUCCESS',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      amount_usd_requested: '100',
      recipient: 'private-recipient',
      refund_to: 'private-refund',
      deposit_address: 'private-deposit',
      terminal_at: new Date('2026-08-06T12:00:00Z'),
      executable_quote: {
        quoteRequest: { appFees: [{ recipient: 'fee-recipient.near', fee: 12 }] },
        quote: {
          amountIn: '100000000',
          amountInFormatted: '1',
          amountInUsd: '100',
          amountOut: '99000000',
          amountOutFormatted: '99',
          amountOutUsd: '99',
          withdrawFee: '1000000',
        },
      },
      last_status_response: {
        swapDetails: {
          depositedAmountFormatted: '0.998',
          depositedAmountUsd: '99.80',
          amountInFormatted: '0.997',
          amountInUsd: '99.70',
          amountOutFormatted: '98.5',
          amountOutUsd: '98.50',
        },
      },
    };
    const json = completedDealEmbed(swap, catalogue, 'abc123').toJSON();
    const rendered = JSON.stringify(json);
    expect(json.title).toBe('✅ Deal Complete');
    expect(json.footer.text).toBe('Order ABC123');
    expect(json.thumbnail.url).toBe('attachment://deal-history.gif');
    expect(json.description.split('\n')[0]).toContain('0.998 LTC');
    expect(json.description.split('\n')[0]).toContain('98.5 USDC');
    expect(json.description.split('\n')[0]).not.toContain('99 USDC');
    expect(json.description.split('\n')[1]).toContain('$100.00 → $99.00');
    expect(json.description.split('\n')[1]).toContain('≈$1.00 (1.00%) total swap cost');
    expect(rendered).toContain('total swap cost');
    expect(rendered).not.toMatch(/bot fee|service fee|\) bot/i);
    expect(rendered).not.toMatch(/private-recipient|private-refund|private-deposit|fee-recipient/);
  });

  it('falls back to quoted amounts for completed deals without settlement details', () => {
    const swap = {
      status: 'SUCCESS',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      amount_usd_requested: '100',
      executable_quote: {
        quote: {
          amountInFormatted: '1',
          amountInUsd: '100',
          amountOutFormatted: '99',
          amountOutUsd: '99',
        },
      },
    };

    const json = completedDealEmbed(swap, catalogue, 'legacy').toJSON();
    expect(json.description.split('\n')[0]).toContain('1 LTC');
    expect(json.description.split('\n')[0]).toContain('99 USDC');
  });

  it('uses the exact settled atomic output for completed deals', () => {
    const swap = {
      status: 'SUCCESS',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      executable_quote: { quote: { amountInFormatted: '1', amountOutFormatted: '99' } },
      last_status_response: {
        swapDetails: {
          amountOut: '98500001',
          amountOutFormatted: '98.5',
        },
      },
    };

    const json = completedDealEmbed(swap, catalogue, 'settled').toJSON();
    expect(json.description.split('\n')[0]).toContain('98.500001 USDC');
    expect(json.description.split('\n')[0]).not.toContain('99 USDC');
  });

  it('uses matched quote USD values instead of later execution-status valuations', () => {
    const swap = {
      status: 'SUCCESS',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '37.95786676',
      executable_quote: {
        quote: {
          amountInFormatted: '37.95786676',
          amountInUsd: '1996.204212908400',
          amountOutFormatted: '2011.68304499027409687',
          amountOutUsd: '1996.204212908400',
        },
      },
      last_status_response: {
        swapDetails: {
          depositedAmountFormatted: '37.95786676',
          depositedAmountUsd: '2020.117668967200',
          amountOutFormatted: '2011.68304499027409687',
          amountOutUsd: '2011.266626599961',
        },
      },
    };

    const json = completedDealEmbed(swap, catalogue, 'matched').toJSON();
    expect(json.description.split('\n')[0]).toContain('37.95786676 LTC');
    expect(json.description.split('\n')[0]).toContain('2011.68304499027409687 USDC');
    expect(json.description.split('\n')[1]).toBe(
      '$1,996.20 → $1,996.20 • ≈$0.00 (0.00%) total swap cost',
    );
    expect(json.description).not.toContain('$2,020.12');
    expect(json.description).not.toContain('$2,011.27');
  });

  it('falls back to execution-status USD values when a legacy quote omitted them', () => {
    const swap = {
      status: 'SUCCESS',
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      executable_quote: { quote: { amountInFormatted: '1', amountOutFormatted: '99' } },
      last_status_response: {
        swapDetails: {
          depositedAmountUsd: '100',
          amountOutUsd: '99',
        },
      },
    };

    const json = completedDealEmbed(swap, catalogue, 'legacy-usd').toJSON();
    expect(json.description.split('\n')[1]).toContain('$100.00 → $99.00');
  });

  it('links completed deals only to the origin deposit transaction', () => {
    const components = completedDealComponents({
      origin_asset_id: assets[5].assetId,
      last_status_response: {
        swapDetails: {
          destinationChainTxHashes: [{ explorerUrl: 'https://destination.example/tx/payout' }],
          originChainTxHashes: [{ explorerUrl: 'https://blockchair.com/litecoin/transaction/deposit' }],
        },
      },
    }, catalogue).map((row) => row.toJSON());
    expect(components[0].components[0]).toMatchObject({
      label: 'View transaction',
      url: 'https://blockchair.com/litecoin/transaction/deposit',
    });
    expect(completedDealComponents({
      origin_asset_id: assets[5].assetId,
      last_status_response: {
        swapDetails: {
          originChainTxHashes: [{ hash: 'valid-transaction-hash', explorerUrl: 'https://explorer.near-intents.org/?search=valid-transaction-hash' }],
        },
      },
    }, catalogue)[0].toJSON().components[0].url).toBe('https://blockchair.com/litecoin/transaction/valid-transaction-hash');
    expect(completedDealComponents({
      origin_asset_id: assets[5].assetId,
      last_status_response: { swapDetails: { originChainTxHashes: [{ hash: 'bad hash', explorerUrl: 'javascript:alert(1)' }] } },
    }, catalogue)).toEqual([]);
  });

  it('removes provider branding, slippage, terms, and risk notices from user-facing views', () => {
    const panel = JSON.stringify(serialize(panelPayload()));
    expect(panel).not.toMatch(/slippage|risk notice|terms/i);

    const ticket = { id: randomUUID(), step: 'PREVIEW', state_data: {} };
    const swap = {
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      amount_usd_requested: '100.00',
      recipient: 'recipient',
      refund_to: 'refund',
      preview_expires_at: new Date(Date.now() + 60_000),
      dry_quote: {
        quoteRequest: { appFees: [{ recipient: 'fee-recipient.near', fee: 30 }] },
        quote: {
          amountIn: '100000000',
          amountInFormatted: '1',
          amountInUsd: '100',
          amountOut: '99000000',
          amountOutFormatted: '99',
          amountOutUsd: '99.70',
          minAmountOut: '98000000',
          withdrawFee: '1000000',
          timeEstimate: 3660,
        },
      },
    };
    const preview = JSON.stringify(serialize(renderTicket(ticket, catalogue, swap, config, policy, emojis)));
    expect(preview).not.toMatch(/slippage|risk notice|terms/i);
    expect(preview).toContain('Double check');
    expect(preview).toContain('Network + Spread fee');
    expect(preview).not.toMatch(/bot fee|service fee/i);
    expect(preview).not.toContain('Estimated time');
    expect(preview).not.toContain('~1 hour 1 minute');
  });

  it('uses a plain service fee for FixedFloat without extra provider disclaimers', () => {
    const ticket = { id: randomUUID(), step: 'PREVIEW', state_data: {} };
    const swap = {
      origin_asset_id: assets[5].assetId,
      destination_asset_id: assets[6].assetId,
      amount_display: '1',
      amount_usd_requested: '100.00',
      recipient: 'recipient',
      refund_to: 'refund',
      preview_expires_at: new Date(Date.now() + 60_000),
      dry_quote: {
        provider: 'fixedfloat',
        providerData: { exchangeId: 'YC33JX' },
        quoteRequest: { appFees: [] },
        quote: {
          amountIn: '100000000',
          amountInFormatted: '1',
          amountInUsd: '100',
          amountOut: '99000000',
          amountOutFormatted: '99',
          amountOutUsd: '99.70',
          minAmountOut: null,
        },
      },
    };
    const preview = serialize(renderTicket(ticket, catalogue, swap, config, policy, emojis));
    const previewText = JSON.stringify(preview);
    expect(previewText).toContain('Backup provider quoted cost');
    expect(previewText).toContain('0.30%');
    expect(previewText).not.toContain('Backup service fee');
    expect(previewText).not.toContain('FixedFloat fallback');

    const active = serialize(renderTicket(
      { ...ticket, step: 'ACTIVE', progress_message_id: 'progress' },
      catalogue,
      {
        ...swap,
        status: 'PENDING_DEPOSIT',
        deposit_address: 'deposit-address',
        quote_deadline: new Date(Date.now() + 60_000),
        executable_quote: swap.dry_quote,
        qr_message_id: null,
      },
      config,
      policy,
      emojis,
    ));
    const activeText = JSON.stringify(active);
    expect(activeText).toContain('Backup provider quoted cost');
    expect(activeText).toContain('Order ID: YC33JX');
    expect(activeText).not.toContain('"name":"Provider"');
    expect(activeText).not.toContain('floating rate · order');

    const expiredActive = serialize(renderTicket(
      { ...ticket, step: 'ACTIVE', progress_message_id: 'progress' },
      catalogue,
      {
        ...swap,
        status: 'PROCESSING',
        deposit_address: 'deposit-address',
        quote_deadline: new Date(Date.now() - 60_000),
        executable_quote: swap.dry_quote,
        last_status_response: { provider: 'fixedfloat', providerStatus: 'EXPIRED', requiresAttention: true },
      },
      config,
      policy,
      emojis,
    ));
    expect(JSON.stringify(expiredActive)).toContain('Deadline elapsed');
    expect(JSON.stringify(expiredActive)).not.toContain('Provider assistance needed');

    const expiredUpdate = statusUpdateEmbed({
      provider: 'fixedfloat',
      providerStatus: 'EXPIRED',
      requiresAttention: true,
      status: 'PROCESSING',
    }, { swap: { executable_quote: swap.dry_quote } }).toJSON();
    expect(expiredUpdate.title).toBe('Deadline elapsed');
    expect(expiredUpdate.footer.text).toBe('Order ID: YC33JX');
  });

  it('drops unsafe explorer URLs from status messages', () => {
    const embed = statusUpdateEmbed({
      status: 'SUCCESS',
      swapDetails: {
        destinationChainTxHashes: [
          { hash: 'bad', explorerUrl: 'javascript:alert(1)' },
          { hash: 'good', explorerUrl: 'https://explorer.example/tx/good' },
        ],
      },
    }).toJSON();
    expect(embed.fields[0].value).toContain('explorer.example');
    expect(embed.fields[0].value).not.toContain('javascript:');
  });

  it('hides a zero refund amount until an actual refund exists', () => {
    const processing = statusUpdateEmbed({
      status: 'PROCESSING',
      swapDetails: { refundedAmountFormatted: '0.000000' },
    }).toJSON();
    const refunded = statusUpdateEmbed({
      status: 'REFUNDED',
      swapDetails: { refundedAmountFormatted: '1.25' },
    }).toJSON();

    expect(processing.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Refunded' }));
    expect(refunded.fields).toContainEqual(expect.objectContaining({ name: 'Refunded', value: '1.25' }));
  });

  it('shows finalized deposited and delivered amounts in successful status messages', () => {
    const success = statusUpdateEmbed({
      status: 'SUCCESS',
      swapDetails: {
        depositedAmountFormatted: '46.698443722468368062',
        amountOutFormatted: '46.25',
      },
    }).toJSON();

    expect(success.fields).toContainEqual(expect.objectContaining({
      name: 'Deposited',
      value: '46.698443722468368062',
    }));
    expect(success.fields).toContainEqual(expect.objectContaining({ name: 'Delivered output', value: '46.25' }));
  });

  it('shows the exact remaining coin amount for an incomplete cumulative deposit', () => {
    const response = {
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: {
        depositedAmount: '75000000',
        depositedAmountFormatted: '0.75',
      },
    };
    const context = {
      swap: {
        origin_asset_id: assets[5].assetId,
        amount_base: '200000000',
        deposit_address: 'ltc-deposit-address',
        quote_deadline: '2026-08-14T18:00:00.000Z',
        executable_quote: { quote: { amountIn: '100000000', amountInFormatted: '1' } },
      },
      originAsset: assets[5],
    };
    const payload = serialize(statusUpdatePayload('ticket', response, context));
    const incomplete = payload.embeds[0];

    expect(incomplete.description).toContain('remaining quoted amount');
    expect(incomplete.fields).toContainEqual({
      name: 'Additional amount needed',
      value: '0.25 LTC (Litecoin)',
    });
    expect(incomplete.fields).toContainEqual(expect.objectContaining({
      name: 'What to do',
      value: expect.stringContaining('after any wallet or exchange withdrawal fee'),
    }));
    const deadline = Math.floor(new Date('2026-08-14T18:00:00.000Z').getTime() / 1000);
    expect(incomplete.fields).toContainEqual({
      name: 'If you do not complete the deposit',
      value: `If no more funds arrive by <t:${deadline}:F> (<t:${deadline}:R>), the deposited funds will begin returning to your configured refund address. Refund arrival may take additional network processing time.`,
    });
    expect(payload.components[0].components).toContainEqual(expect.objectContaining({
      custom_id: 't:ticket:show-incomplete-deposit',
      label: 'Copy details',
    }));
  });

  it('does not guess a remaining amount when provider base-unit data is unavailable', () => {
    const incomplete = statusUpdateEmbed({
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: { depositedAmountFormatted: '0.75' },
    }, {
      swap: { executable_quote: { quote: { amountIn: '100000000' } } },
      originAsset: assets[5],
    }).toJSON();

    expect(incomplete.description).toContain('could not be calculated safely');
    expect(incomplete.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Additional amount needed' }));
    expect(incomplete.fields).toContainEqual({
      name: 'If you do not complete the deposit',
      value: expect.stringContaining('the funding deadline shown in the main swap message'),
    });
  });

  it('puts Close ticket on the final private status message', () => {
    const payload = serialize(statusUpdatePayload(randomUUID(), { status: 'SUCCESS' }));
    expect(payload.components[0].components.map((button) => button.label)).toEqual(['Close ticket']);
  });

  it('renders a completed-looking payout message with the finalized amount and owner-only ping', () => {
    const payload = payoutSentPayload('owner', {
      destination_asset_id: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
      executable_quote: { quote: { amountOutFormatted: '98' } },
    }, {
      status: 'PROCESSING',
      updatedAt: '2026-08-11T12:00:00.000Z',
      swapDetails: {
        amountOutFormatted: '99.25',
        destinationChainTxHashes: [{
          hash: 'destination-transaction-hash',
          explorerUrl: 'https://explorer.example/tx/destination-transaction-hash',
        }],
      },
    }, catalogue);

    expect(payload.content).toBe(
      '<@owner> Your payout of `99.25 USDC` has been sent to your receiving wallet. This ticket will close automatically after the transaction is confirmed.',
    );
    expect(payload.allowedMentions).toEqual({ users: ['owner'] });
    expect(payload.embeds[0].toJSON()).toMatchObject({
      title: 'Payout sent',
      color: 5763719,
      fields: [{ name: 'Destination transaction', value: expect.stringContaining('explorer.example') }],
    });
    expect(payload.components).toEqual([]);
  });

  it('does not expose provider-branded explorer links in status or payout messages', () => {
    const transaction = {
      hash: 'destination-transaction-hash',
      explorerUrl: 'https://explorer.near-intents.org/?search=destination-transaction-hash',
    };
    const status = statusUpdateEmbed({
      status: 'PROCESSING',
      swapDetails: { destinationChainTxHashes: [transaction] },
    }).toJSON();
    const payout = payoutSentPayload('owner', {
      destination_asset_id: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
      executable_quote: { quote: { amountOutFormatted: '98' } },
    }, {
      status: 'PROCESSING',
      swapDetails: { destinationChainTxHashes: [transaction] },
    }, catalogue);

    expect(JSON.stringify(status)).not.toMatch(/near[- ]intents|1click/i);
    expect(JSON.stringify(payout)).not.toMatch(/near[- ]intents|1click/i);
    expect(status.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Explorers' }));
    expect(payout.embeds[0].toJSON().fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Destination transaction' }));
  });

  it('renders a closing payout message for a BlockCypher broadcast', () => {
    const ticketId = randomUUID();
    const payload = payoutClosingPayload('owner', {
      destination_asset_id: 'nep141:ltc.omft.near',
      executable_quote: { quote: { amountOutFormatted: '1.25' } },
    }, {
      status: 'PROCESSING',
      updatedAt: '2026-08-11T12:00:00.000Z',
      swapDetails: {
        destinationChainTxHashes: [{
          hash: 'destination-transaction-hash',
          explorerUrl: 'https://blockchair.com/litecoin/transaction/destination-transaction-hash',
        }],
      },
    }, catalogue, ticketId, new Date('2026-08-11T12:05:00.000Z'));
    const rendered = serialize(payload);

    expect(payload.content).toBe(
      '<@owner> Your payout of `1.25 LTC` has been sent to your receiving wallet. This ticket will be deleted <t:1786449900:F> (<t:1786449900:R>) unless you close it first.',
    );
    expect(rendered.embeds[0]).toMatchObject({
      title: 'Swap completed',
      description: 'The destination transfer has been broadcast to your receiving wallet. No further action is required.',
    });
    expect(rendered.components[0].components[0]).toMatchObject({ label: 'Close ticket' });
    expect(payload.allowedMentions).toEqual({ users: ['owner'] });
  });
});

function entry(symbol, blockchain, assetId, decimals) {
  return { symbol, blockchain, assetId, decimals, contractAddress: null };
}

describe('FixedFloat underpayment controls', () => {
  const response = {provider:'fixedfloat',providerStatus:'EMERGENCY',status:'INCOMPLETE_DEPOSIT',requiresAttention:true,emergency:{reasons:['LESS'],choice:'NONE',repeat:false}};
  const context = {swap:{executable_quote:{provider:'fixedfloat',providerData:{exchangeId:'ABC123'}}}};
  it('offers explicit choices and the order link without top-up or automatic refund instructions', () => {
    const result = serialize(statusUpdatePayload('ticket', response, context));
    expect(result.components[0].components.map(x=>x.custom_id)).toEqual(['t:ticket:ff-exchange','t:ticket:ff-refund']);
    expect(JSON.stringify(result)).toContain('https://ff.io/order/ABC123');
    expect(JSON.stringify(result)).not.toMatch(/same deposit address|begin returning|Contact FixedFloat support/);
  });
  it('hides exchange below the limits and hides all choices after a decision', () => {
    const limited=serialize(statusUpdatePayload('ticket',{...response,emergency:{...response.emergency,reasons:['LESS','LIMIT']}},context));
    expect(limited.components[0].components).toHaveLength(1);
    expect(limited.components[0].components[0].custom_id).toBe('t:ticket:ff-refund');
    expect(serialize(statusUpdatePayload('ticket',{...response,emergency:{...response.emergency,choice:'REFUND'}},context)).components).toEqual([]);
  });
});

 describe('completed FixedFloat fee estimate', () => {
  it('keeps the active ticket fee estimate even when settled values change', () => {
    const catalogue={getAsset:id=>({symbol:id,blockchain:'eth',decimals:6})};
    const swap={origin_asset_id:'USDC',destination_asset_id:'USDT',executable_quote:{provider:'fixedfloat',quote:{amountInFormatted:'100',amountOutFormatted:'99',amountInUsd:'100',amountOutUsd:'99',providerUsd:{amountInUsd:100,amountOutUsd:99.8}}},last_status_response:{swapDetails:{amountInUsd:'100',amountOutUsd:'99.2',providerUsd:{amountInUsd:100,amountOutUsd:99.5}}}};
    expect(completedDealEmbed(swap,catalogue,'test12').toJSON().description).toContain('0.20% total swap cost');
    expect(completedDealEmbed(swap,catalogue,'test12').toJSON().description).toContain('Quoted USD: $100.00 → $99.80');
    swap.last_status_response.swapDetails.amountOutUsd='99.9';
    expect(completedDealEmbed(swap,catalogue,'test12').toJSON().description).toContain('0.20% total swap cost');
    delete swap.last_status_response.swapDetails.providerUsd;
    swap.last_status_response.swapDetails.amountOutUsd='99';
    expect(completedDealEmbed(swap,catalogue,'test12').toJSON().description).toContain('0.20% total swap cost');
    swap.executable_quote.quote.amountOutUsd='99.9';
    expect(completedDealEmbed(swap,catalogue,'test12').toJSON().description).toContain('Quoted USD: $100.00 → $99.90 • 0.10%');
    delete swap.executable_quote.quote.providerUsd;
    expect(completedDealEmbed(swap,catalogue,'test12').toJSON().description).toContain('Quoted USD: $100.00 → $99.90 • 0.10%');

  });
});
