import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { CoinPolicy, networkLabel, OTHER_COIN_KEY } from '../services/coin-policy.js';
import { messageForErrorCode } from '../services/error-classifier.js';
import {
  formatUsd,
  fromBaseUnits,
  lowerConsistentNetworkAndSpreadFeeDisplay,
  lowerQuotedRouteCostValues,
  quoteAppFeeBps,
  quotedNetworkAndSpreadFeeDisplay,
  quotedRouteCostPercentDisplay,
} from '../utils/amounts.js';
import { truncate } from '../utils/pagination.js';
import { POPULAR_SWAPS } from '../services/popular-swaps.js';
import { transactionExplorerUrl } from '../services/transaction-explorer.js';

const STATUS_COPY = {
  PENDING_DEPOSIT: ['Awaiting deposit', Colors.Yellow, 'Waiting for the exact deposit shown below.'],
  KNOWN_DEPOSIT_TX: ['Deposit detected', Colors.Blue, 'The deposit transaction was detected and is waiting for network confirmation.'],
  INCOMPLETE_DEPOSIT: ['Incomplete deposit', Colors.Orange, 'A partial deposit was detected, but the remaining amount could not be calculated safely. Use Check status or contact support before sending more.'],
  PROCESSING: ['Swap processing', Colors.Blue, 'The swap is being processed.'],
  SUCCESS: ['Swap completed', Colors.Green, 'The destination assets were delivered successfully.'],
  REFUNDED: ['Swap refunded', Colors.Orange, 'The swap was refunded to the configured origin-chain refund address.'],
  FAILED: ['Swap failed', Colors.Red, 'The swap failed. Review the returned explorer details and refund address.'],
  TRACKING_STALE: ['Automatic tracking stopped', Colors.Grey, 'The tracking window expired without a terminal status. The database record has been retained.'],
};

const FALLBACK_EMOJIS = { get: () => '🔹' };

function componentId(ticketId, action, argument = null) {
  return ['t', ticketId, action, argument].filter((part) => part !== null).join(':');
}

function safeCode(value) {
  return String(value ?? '').replaceAll('`', '\u02cb').replace(/[\r\n]/g, ' ').slice(0, 1000);
}

export function panelPayload(disabled = false) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('Crypto-to-Crypto Swap')
    .setDescription('Open a ticket to swap between supported coins in just a few minutes for a **0% service fee**.')
    .addFields({
      name: 'How it works',
      value: 'Choose your coins and networks → enter an amount and wallet addresses → review the quote → deposit from your own wallet → track delivery.',
    })
    .setFooter({ text: 'One open swap ticket per member' });

  const startButton = new ButtonBuilder()
    .setCustomId('panel:start')
    .setLabel(disabled ? 'Temporarily unavailable' : 'Start swap')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);

  const supportedCoinsButton = new ButtonBuilder()
    .setCustomId('panel:supported-coins')
    .setLabel('Supported Coins')
    .setEmoji('🪙')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(startButton, supportedCoinsButton)],
  };
}

export function supportedCoinsPayload(policy) {
  const coinLine = (coin) => `**${safeCode(coin.key)}** — ${safeCode(policy.describeNetworks(coin.key))}`;
  const featured = policy.getFeaturedCoins();
  const other = policy.getOtherCoins();
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('🪙 Supported Coins')
    .setDescription('These coins and networks are currently available. Individual route availability is confirmed when your ticket quote is created.');

  if (featured.length > 0) {
    embed.addFields({ name: 'Featured', value: featured.map(coinLine).join('\n').slice(0, 1024) });
  }
  if (other.length > 0) {
    embed.addFields({ name: 'More coins', value: other.map(coinLine).join('\n').slice(0, 1024) });
  }
  if (featured.length === 0 && other.length === 0) {
    embed.addFields({ name: 'Availability', value: 'No coins are currently available. Please try again shortly.' });
  }

  return { embeds: [embed], components: [] };
}

export function ticketHeaderPayload(ticketId) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('Private swap controls')
    .setDescription('Use the messages below to complete your swap. Never share a private key or seed phrase.');
  const close = new ButtonBuilder()
    .setCustomId(componentId(ticketId, 'close'))
    .setLabel('Close ticket')
    .setStyle(ButtonStyle.Danger);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(close)] };
}

export function closeConfirmationPayload(ticketId, hasExecutableSwap) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle('Close this ticket?')
    .setDescription(hasExecutableSwap
      ? '**This deletes the private channel immediately.** It does not cancel the swap or stop automatic tracking.'
      : '**This deletes the private channel immediately** and discards the unfinished swap setup.');
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(componentId(ticketId, 'close-confirm')).setLabel('Close ticket').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(componentId(ticketId, 'close-cancel')).setLabel('Keep ticket open').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [actions] };
}

export function renderTicket(ticket, catalogue, swap, config, suppliedPolicy = null, suppliedEmojis = null) {
  void config;
  const data = ticket.state_data ?? {};
  const policy = suppliedPolicy ?? new CoinPolicy(catalogue);
  const emojis = suppliedEmojis ?? FALLBACK_EMOJIS;
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('Private swap ticket');

  if (ticket.step === 'ORIGIN_COIN') {
    const select = coinMenu(ticket.id, 'select-origin-coin', policy.getFeaturedCoins(), emojis, data.originCoin, {
      placeholder: 'Choose the coin you are sending',
      includeOther: policy.hasOtherCoins(),
      otherCount: policy.getOtherCoins().length,
      assetCountForCoin: (definition) => policy.getAssetsForCoin(definition.key).length,
    });
    const popular = new ActionRowBuilder().addComponents(POPULAR_SWAPS.map((route) => new ButtonBuilder()
      .setCustomId(componentId(ticket.id, route.action))
      .setLabel(route.label)
      .setStyle(ButtonStyle.Secondary)));
    const container = new ContainerBuilder()
      .setAccentColor(Colors.Blurple)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '## 1 of 5 — What are you sending?\nChoose the coin currently held in your wallet. You will choose a network only when that coin has multiple supported options.\n\n**Popular picks**\nUse a shortcut below to select both sides of the swap.',
      ))
      .addActionRowComponents(popular)
      .addActionRowComponents(new ActionRowBuilder().addComponents(select));
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  if (ticket.step === 'ORIGIN_OTHER') {
    const select = coinMenu(ticket.id, 'select-origin-other', policy.getOtherCoins(), emojis, data.originCoin, {
      placeholder: 'Choose another sending coin',
      assetCountForCoin: (definition) => policy.getAssetsForCoin(definition.key).length,
    });
    embed.setDescription('**1 of 5 — Other sending coins**\nChoose one of the additional supported assets.');
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), backRow(ticket.id)] };
  }

  if (ticket.step === 'ORIGIN_NETWORK') {
    const assets = policy.getAssetsForCoin(data.originCoin);
    embed.setDescription(`**1 of 5 — Which ${safeCode(data.originCoin)} network?**\nSelect the network where your funds currently are.`);
    return {
      embeds: [embed],
      components: [networkMenuRow(ticket.id, 'select-origin-network', data.originCoin, assets, emojis, data.originAssetId), backRow(ticket.id)],
    };
  }

  if (ticket.step === 'DESTINATION_COIN') {
    const origin = catalogue.getAsset(data.originAssetId);
    const select = coinMenu(ticket.id, 'select-destination-coin', policy.getFeaturedCoins(data.originAssetId), emojis, data.destinationCoin, {
      placeholder: 'Choose the coin you want to receive',
      includeOther: policy.hasOtherCoins(data.originAssetId),
      otherCount: policy.getOtherCoins(data.originAssetId).length,
      assetCountForCoin: (definition) => policy.getAssetsForCoin(definition.key, data.originAssetId).length,
    });
    const automatic = data.originNetworkAutoSelected
      ? `\n${networkLabel(origin?.blockchain)} was selected automatically because it is the only approved ${safeCode(data.originCoin)} network.`
      : '';
    embed.setDescription(`**2 of 5 — What do you want to receive?**\nYou are sending **${assetSummary(origin)}**.${automatic}`);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), backRow(ticket.id)] };
  }

  if (ticket.step === 'DESTINATION_OTHER') {
    const origin = catalogue.getAsset(data.originAssetId);
    const select = coinMenu(ticket.id, 'select-destination-other', policy.getOtherCoins(data.originAssetId), emojis, data.destinationCoin, {
      placeholder: 'Choose another receiving coin',
      assetCountForCoin: (definition) => policy.getAssetsForCoin(definition.key, data.originAssetId).length,
    });
    embed.setDescription(`**2 of 5 — Other receiving coins**\nYou are sending **${assetSummary(origin)}**. Choose an additional supported asset to receive.`);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), backRow(ticket.id)] };
  }

  if (ticket.step === 'DESTINATION_NETWORK') {
    const origin = catalogue.getAsset(data.originAssetId);
    const assets = policy.getAssetsForCoin(data.destinationCoin, data.originAssetId);
    embed.setDescription(`**2 of 5 — Which ${safeCode(data.destinationCoin)} network?**\nYou are sending **${assetSummary(origin)}**. Select the network where you want to receive funds.`);
    return {
      embeds: [embed],
      components: [networkMenuRow(ticket.id, 'select-destination-network', data.destinationCoin, assets, emojis, data.destinationAssetId), backRow(ticket.id)],
    };
  }

  if (ticket.step === 'USD_AMOUNT') {
    const origin = catalogue.getAsset(data.originAssetId);
    const destination = catalogue.getAsset(data.destinationAssetId);
    embed.setDescription(['USDT', 'USDC'].includes(origin?.symbol)
      ? `**3 of 5 — How much ${safeCode(origin.symbol)}?**\nType the token amount directly in this channel. Example: **25** means **25 ${safeCode(origin.symbol)}**.`
      : '**3 of 5 — How much in USD?**\nType the USD value you want to swap directly in this channel.\nExample: **25**')
      .addFields(...summaryFields(origin, destination));
    return { embeds: [embed], components: [backRow(ticket.id)] };
  }

  if (ticket.step === 'RECIPIENT_ADDRESS') {
    const origin = catalogue.getAsset(data.originAssetId);
    const destination = catalogue.getAsset(data.destinationAssetId);
    const receivingNetwork = safeCode(networkLabel(destination?.blockchain));
    embed.setDescription(`**4 of 5 — Receiving address**\n\n## Send your ${receivingNetwork} receiving address below\n${rememberedAddressInstructions(data.rememberedRecipientAddress, receivingNetwork)}`)
      .addFields(
        ...summaryFields(origin, destination),
        { name: ['USDT', 'USDC'].includes(origin?.symbol) ? 'Token amount' : 'USD amount', value: ['USDT', 'USDC'].includes(origin?.symbol) ? `${safeCode(data.amountDisplay)} ${safeCode(origin.symbol)}` : formatUsd(data.amountUsdRequested), inline: true },
        { name: 'Estimated input', value: `${safeCode(data.amountDisplay)} ${safeCode(origin?.symbol)}`, inline: true },
      );
    return { embeds: [embed], components: [backRow(ticket.id)] };
  }

  if (ticket.step === 'REFUND_ADDRESS') {
    const origin = catalogue.getAsset(data.originAssetId);
    const destination = catalogue.getAsset(data.destinationAssetId);
    const refundNetwork = safeCode(networkLabel(origin?.blockchain));
    embed.setColor(Colors.Orange)
      .setTitle(`Refund address required — ${refundNetwork}`)
      .setDescription(`**4 of 5 — Refund address**\n\n## Send your ${refundNetwork} refund address below\n${rememberedAddressInstructions(data.rememberedRefundAddress, refundNetwork)}`)
      .addFields(
        ...summaryFields(origin, destination),
        { name: ['USDT', 'USDC'].includes(origin?.symbol) ? 'Token amount' : 'USD amount', value: ['USDT', 'USDC'].includes(origin?.symbol) ? `${safeCode(data.amountDisplay)} ${safeCode(origin.symbol)}` : formatUsd(data.amountUsdRequested), inline: true },
        { name: 'Receiving address', value: `\`${safeCode(data.recipient)}\`` },
      );
    const lastError = messageForErrorCode(ticket.last_error_code);
    if (lastError) embed.addFields({ name: 'Last quote issue', value: lastError });
    return { embeds: [embed], components: [backRow(ticket.id)] };
  }

  if (ticket.step === 'QUOTE_LOADING') {
    embed.setDescription('**5 of 5 — Preparing your preview…**\nChecking this route and calculating the current output.');
    return { embeds: [embed], components: [] };
  }

  if (ticket.step === 'PREVIEW' && swap) return renderPreview(ticket, catalogue, swap);
  if ((ticket.step === 'ACTIVE' || ticket.step === 'TERMINAL') && swap) return renderActive(ticket, catalogue, swap);

  embed.setColor(Colors.Grey).setDescription('This ticket is closing. Its private channel will be deleted shortly.');
  return { embeds: [embed], components: [] };
}

function rememberedAddressInstructions(address, network) {
  if (!address) return `Paste any ${network} address as your next message.`;
  return `Type **\`yes\`** to reuse your last ${network} address:\n\`${safeCode(address)}\`\n\nOr paste any other ${network} address.`;
}

function coinMenu(ticketId, action, coins, emojis, selected, {
  placeholder,
  includeOther = false,
  otherCount = 0,
  assetCountForCoin = (definition) => definition.assets.length || 1,
}) {
  const options = coins.map((definition) => new StringSelectMenuOptionBuilder()
    .setLabel(definition.key)
    .setDescription(truncate(`${definition.name} • ${pluralNetwork(assetCountForCoin(definition))}`, 100))
    .setValue(definition.key)
    .setEmoji(emojis.get(definition.key))
    .setDefault(selected === definition.key));
  if (includeOther) {
    options.push(new StringSelectMenuOptionBuilder()
      .setLabel('Other')
      .setDescription(`${otherCount} additional coin${otherCount === 1 ? '' : 's'}`)
      .setValue(OTHER_COIN_KEY)
      .setEmoji(emojis.get('other')));
  }
  return new StringSelectMenuBuilder().setCustomId(componentId(ticketId, action)).setPlaceholder(placeholder).addOptions(options);
}

function pluralNetwork(count) {
  return `${count} approved network${count === 1 ? '' : 's'}`;
}

function networkMenuRow(ticketId, action, coinKey, assets, emojis, selectedAssetId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(componentId(ticketId, action))
    .setPlaceholder(`Choose the ${coinKey} network`)
    .addOptions(assets.map((entry) => new StringSelectMenuOptionBuilder()
      .setLabel(networkLabel(entry.blockchain))
      .setDescription(`${coinKey} on ${networkLabel(entry.blockchain)}`)
      .setValue(entry.assetId)
      .setEmoji(emojis.get(coinKey))
      .setDefault(entry.assetId === selectedAssetId)));
  return new ActionRowBuilder().addComponents(select);
}

function backRow(ticketId) {
  return new ActionRowBuilder().addComponents(backButton(ticketId));
}

function backButton(ticketId) {
  return new ButtonBuilder().setCustomId(componentId(ticketId, 'back')).setLabel('Back').setStyle(ButtonStyle.Secondary);
}

function summaryFields(origin, destination) {
  return [
    { name: 'You send', value: assetSummary(origin), inline: true },
    { name: 'You receive', value: assetSummary(destination), inline: true },
  ];
}

function assetSummary(asset) {
  if (!asset) return 'Unavailable asset';
  return `${safeCode(asset.symbol)} on ${safeCode(networkLabel(asset.blockchain))}`;
}

function renderPreview(ticket, catalogue, swap) {
  const origin = catalogue.getAsset(swap.origin_asset_id);
  const destination = catalogue.getAsset(swap.destination_asset_id);
  const quote = swap.dry_quote.quote;
  const changeNow = ['changenow', 'changelly', 'fixedfloat'].includes(swap.dry_quote.provider);
  const providerName = swap.dry_quote.provider === 'fixedfloat' ? 'FixedFloat' : swap.dry_quote.provider === 'changelly' ? 'Changelly' : 'ChangeNOW';
  const fixedFloat = swap.dry_quote.provider === 'fixedfloat';
  const expires = Math.floor(new Date(swap.preview_expires_at).getTime() / 1000);
  const quoted = Math.floor(new Date(swap.updated_at ?? Date.now()).getTime() / 1000);
  const inputUsd = quote.amountInUsd ?? swap.amount_usd_requested;
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('🔍 Double check')
    .setDescription(`Confirming creates real deposit instructions. Funds move only after you send them.\n\nQuoted <t:${quoted}:R> • expires <t:${expires}:R>`)
    .addFields(
      { name: 'You send', value: `${safeCode(quote.amountInFormatted ?? swap.amount_display)} ${safeCode(origin?.symbol)} (≈${formatUsd(inputUsd)})` },
      { name: 'You get', value: `~${safeCode(quote.amountOutFormatted)} ${safeCode(destination?.symbol)} (≈${formatUsd(quote.amountOutUsd)})` },
      {
        name: 'Network',
        value: `${safeCode(origin?.symbol)} on ${safeCode(networkLabel(origin?.blockchain))} → ${safeCode(destination?.symbol)} on ${safeCode(networkLabel(destination?.blockchain))}`,
      },
      { name: fixedFloat ? 'Backup provider quoted cost' : 'Network + Spread fee', value: fixedFloat ? quotedRouteCostPercentDisplay(quote) : quotedNetworkAndSpreadFeeDisplay(quote, quoteAppFeeBps(swap.dry_quote)), inline: true },
    );
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(componentId(ticket.id, 'confirm')).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(componentId(ticket.id, 'back')).setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(componentId(ticket.id, 'refresh-preview')).setLabel('Refresh quote').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );
  if (changeNow && !fixedFloat) embed.addFields({
    name: `${providerName} fallback · floating rate`,
    value: `1Click returned no route for this amount. The received amount is an estimate and may change while your deposit confirms; there is no guaranteed minimum. Bot markup: 0%. ${providerName} service, partner and network costs are included in the estimate. ${providerName} may require verification or support assistance.`,
  });
  if (quote.providerNotices?.length) embed.addFields({ name: 'Provider payment notes', value: quote.providerNotices.map(safeCode).join('\n').slice(0, 1024) });
  return { embeds: [embed], components: [actions] };
}

function renderActive(ticket, catalogue, swap) {
  const origin = catalogue.getAsset(swap.origin_asset_id);
  const destination = catalogue.getAsset(swap.destination_asset_id);
  const quote = swap.executable_quote.quote;
  const changeNow = ['changenow', 'changelly', 'fixedfloat'].includes(swap.executable_quote.provider);
  const providerName = swap.executable_quote.provider === 'fixedfloat' ? 'FixedFloat' : swap.executable_quote.provider === 'changelly' ? 'Changelly' : 'ChangeNOW';
  const fixedFloat = swap.executable_quote.provider === 'fixedfloat';
  const completed = swap.status === 'SUCCESS';
  const terminal = ['SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE'].includes(swap.status);
  const settlement = finalizedSettlementAmounts(swap, destination);
  const [statusLabel, color, statusDescription] = STATUS_COPY[swap.status] ?? [swap.status, Colors.Grey, 'The swap status was updated.'];
  const deadline = Math.floor(new Date(swap.quote_deadline).getTime() / 1000);
  const amount = safeCode(completed ? settlement.amountInFormatted : quote.amountInFormatted ?? swap.amount_display);
  const originSymbol = safeCode(origin?.symbol);
  const originNetwork = safeCode(networkLabel(origin?.blockchain));
  const title = swap.status === 'PENDING_DEPOSIT' ? '📤 Send your swap' : statusLabel;
  const description = swap.status === 'PENDING_DEPOSIT'
    ? `Send **${amount} ${originSymbol} (${originNetwork})** to the address below to start your swap.`
    : statusDescription;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: 'Address', value: `\`${safeCode(swap.deposit_address)}\`` },
      { name: completed ? 'Deposited' : 'Amount', value: `\`${amount} ${originSymbol}\`` },
      {
        name: completed ? 'You received' : 'You receive',
        value: `${completed ? '' : '~'}${safeCode(completed ? settlement.amountOutFormatted : quote.amountOutFormatted)} ${safeCode(destination?.symbol)} (${safeCode(networkLabel(destination?.blockchain))}) at \`${safeCode(swap.recipient)}\``,
      },
      { name: fixedFloat ? 'Backup provider quoted cost' : 'Network + Spread fee', value: fixedFloat ? quotedRouteCostPercentDisplay(quote) : quotedNetworkAndSpreadFeeDisplay(quote, quoteAppFeeBps(swap.executable_quote)), inline: true },
      { name: ['changenow', 'changelly', 'fixedfloat'].includes(swap.executable_quote?.provider) ? 'Local funding window' : 'Funding deadline', value: `⏰ <t:${deadline}:F> (<t:${deadline}:R>) — do not send after this time.` },
    );
  if (swap.deposit_memo) embed.addFields({ name: 'Memo', value: `\`${safeCode(swap.deposit_memo)}\`` });
  if (swap.executable_quote.provider === 'relay' && swap.last_status_response?.requiresAttention) {
    embed.addFields({ name: 'Swap needs review', value: 'Do not send another deposit. Contact bot support with this ticket; automatic settlement and refund tracking continue.' });
  }
  if (changeNow) {
    if (fixedFloat && swap.last_status_response?.providerStatus === 'EXPIRED') {
      embed.addFields({ name: 'Deadline elapsed', value: 'The deposit deadline elapsed. Do not send funds to this address.' });
    } else if (swap.last_status_response?.requiresAttention) embed.addFields({ name: 'Provider assistance needed', value: `${providerName} reports a verification or failed-exchange review. Do not send another deposit. Contact ${providerName} support with the order ID; tracking will continue.` });
  }
  if (fixedFloat && swap.executable_quote?.providerData?.exchangeId) {
    embed.setFooter({ text: `Order ID: ${safeCode(swap.executable_quote.providerData.exchangeId)}` });
  }
  if (swap.qr_message_id === ticket.progress_message_id) embed.setThumbnail('attachment://deposit-address.png');

  if (terminal) {
    return {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(componentId(ticket.id, 'close')).setLabel('Close ticket').setEmoji('✖️').setStyle(ButtonStyle.Danger),
      )],
    };
  }
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(componentId(ticket.id, 'refresh')).setLabel('Check status').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(componentId(ticket.id, 'show-deposit')).setLabel('Copy details').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    )],
  };
}

export function depositSpeedupPayload(swap) {
  let color = Colors.Blurple;
  let title = '⚡ Speed up deposit detection (optional)';
  let description = 'After sending, paste only the sending-network transaction ID (txid) in this chat. Never paste a private key or seed phrase.';

  if (swap.deposit_tx_hash) {
    color = Colors.Green;
    title = '✅ Transaction ID submitted';
    description = 'The provider has been notified. Automatic tracking is continuing.';
  } else if (swap.status !== 'PENDING_DEPOSIT') {
    color = Colors.Green;
    title = '✅ Transaction ID no longer needed';
    description = 'This swap has moved beyond the awaiting-deposit stage. Follow the main status message above.';
  }

  return {
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)],
    components: [],
  };
}

export function completedDealEmbed(swap, catalogue, reference) {
  const origin = catalogue.getAsset(swap.origin_asset_id);
  const destination = catalogue.getAsset(swap.destination_asset_id);
  const settlement = finalizedSettlementAmounts(swap, destination);
  const fixedFloat = swap.executable_quote?.provider === 'fixedfloat';
  const usdValues = fixedFloat ? lowerQuotedRouteCostValues(swap.executable_quote.quote) : settlement;
  const fee = fixedFloat
    ? quotedRouteCostPercentDisplay(swap.executable_quote.quote)
    : lowerConsistentNetworkAndSpreadFeeDisplay(settlement, 0);
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('✅ Deal Complete')
    .setDescription(
      `**${safeCode(settlement.amountInFormatted)} ${safeCode(origin?.symbol)} (${safeCode(networkLabel(origin?.blockchain))}) → ${safeCode(settlement.amountOutFormatted)} ${safeCode(destination?.symbol)} (${safeCode(networkLabel(destination?.blockchain))})**\n`
      + `${fixedFloat ? 'Quoted USD: ' : ''}${formatUsd(usdValues?.amountInUsd)} → ${formatUsd(usdValues?.amountOutUsd)} • ${fee} total swap cost`,
    )
    .setThumbnail('attachment://deal-history.gif')
    .setFooter({ text: `Order ${reference.slice(0, 6).toUpperCase()}` });
}

export function completedDealComponents(swap, catalogue = null) {
  const details = swap.last_status_response?.swapDetails ?? {};
  const transactions = details.originChainTxHashes ?? [];
  const link = transactions
    .map((transaction) => safeExplorerLink(transaction?.explorerUrl))
    .find(isUnbrandedExplorerLink)
    ?? depositExplorerLink(swap, transactions, catalogue);
  if (!link) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('View transaction').setStyle(ButtonStyle.Link).setURL(link.url),
  )];
}

function depositExplorerLink(swap, transactions, catalogue) {
  const blockchain = catalogue?.getAsset?.(swap.origin_asset_id)?.blockchain;
  const hashes = [...transactions.map((transaction) => transaction?.hash), swap.deposit_tx_hash];
  return hashes
    .map((hash) => transactionExplorerUrl(blockchain, hash))
    .map(safeExplorerLink)
    .find(Boolean) ?? null;
}

export function statusUpdateEmbed(statusResponse, context = {}) {
  const [label, color, defaultDescription] = STATUS_COPY[statusResponse.status] ?? [statusResponse.status, Colors.Grey, 'The swap status was updated.'];
  const incompleteDeposit = incompleteDepositDetails(statusResponse, context.swap, context.originAsset);
  const description = incompleteDeposit
    ? 'A partial deposit was detected. The swap can continue after the remaining quoted amount arrives.'
    : defaultDescription;
  const embed = new EmbedBuilder().setColor(color).setTitle(label).setDescription(description).setTimestamp(new Date(statusResponse.updatedAt ?? Date.now()));
  if (statusResponse.provider === 'relay' && statusResponse.requiresAttention) {
    embed.setTitle('Swap needs review').setDescription('Do not send another deposit. Contact bot support with this ticket; automatic settlement and refund tracking continue.');
  }
  if (statusResponse.provider === 'fixedfloat' && statusResponse.providerStatus === 'EXPIRED') {
    embed.setTitle('Deadline elapsed').setDescription('The deposit deadline elapsed. Do not send funds to this address.');
  } else if (['changenow', 'changelly', 'fixedfloat'].includes(statusResponse.provider) && statusResponse.requiresAttention) {
    const name = statusResponse.provider === 'fixedfloat' ? 'FixedFloat' : statusResponse.provider === 'changelly' ? 'Changelly' : 'ChangeNOW';
    embed.setTitle(`${name} assistance needed`).setDescription(`This exchange needs verification or support review. Do not send another deposit. Contact ${name} support with the order ID in your deposit instructions. Automatic tracking continues.`);
  }
  const fixedFloatOrderId = context.swap?.executable_quote?.provider === 'fixedfloat'
    ? context.swap.executable_quote.providerData?.exchangeId
    : null;
  if (fixedFloatOrderId && statusResponse.requiresAttention) {
    embed.setDescription('Do not send another deposit. Open your FixedFloat order to review the available recovery options. Automatic tracking continues.');
    if (statusResponse.emergency?.reasons?.includes('LESS')) embed.setTitle('Incomplete deposit');
    embed.addFields({ name: 'FixedFloat order', value: `[Open order](https://ff.io/order/${encodeURIComponent(fixedFloatOrderId)})` });
    if (fixedFloatRecoveryAvailable(statusResponse)) embed.setDescription('FixedFloat received less than the order amount. Do not send another deposit. Choose to exchange the received funds at the current market rate or refund them to your configured refund address minus the network fee.');
  }
  if (fixedFloatOrderId) embed.setFooter({ text: `Order ID: ${safeCode(fixedFloatOrderId)}` });
  const details = statusResponse.swapDetails ?? {};
  if (incompleteDeposit) {
    embed.addFields(
      {
        name: 'Additional amount needed',
        value: `${safeCode(incompleteDeposit.remainingFormatted)} ${safeCode(incompleteDeposit.symbol)} (${safeCode(incompleteDeposit.network)})`,
      },
      {
        name: 'What to do',
        value: 'Send the additional amount to the same deposit address using the same network. Ensure the full amount above arrives after any wallet or exchange withdrawal fee. Reuse the memo/tag if one was provided.',
      },
    );
  }
  if (statusResponse.status === 'INCOMPLETE_DEPOSIT' && statusResponse.provider !== 'fixedfloat') {
    embed.addFields({
      name: 'If you do not complete the deposit',
      value: incompleteDepositRefundTiming(swapDeadlineUnix(context.swap)),
    });
  }
  const depositedAmount = firstPopulatedValue(details.depositedAmountFormatted, details.amountInFormatted);
  if (statusResponse.status === 'SUCCESS' && depositedAmount) {
    embed.addFields({ name: 'Deposited', value: safeCode(depositedAmount), inline: true });
  }
  if (details.amountOutFormatted) embed.addFields({ name: 'Delivered output', value: safeCode(details.amountOutFormatted), inline: true });
  if (isNonZeroFormattedAmount(details.refundedAmountFormatted)) {
    embed.addFields({ name: 'Refunded', value: safeCode(details.refundedAmountFormatted), inline: true });
  }
  const links = [...(details.originChainTxHashes ?? []), ...(details.destinationChainTxHashes ?? [])]
    .map((transaction) => safeExplorerLink(transaction?.explorerUrl))
    .filter(isUnbrandedExplorerLink)
    .slice(0, 5)
    .map((link, index) => `[${safeCode(link.hostname)} transaction ${index + 1}](${link.url})`);
  if (links.length > 0) embed.addFields({ name: 'Explorers', value: links.join(' • ') });
  return embed;
}

export function statusUpdatePayload(ticketId, statusResponse, context = {}) {
  const terminal = ['SUCCESS', 'REFUNDED', 'FAILED', 'TRACKING_STALE'].includes(statusResponse.status);
  const incompleteDeposit = incompleteDepositDetails(statusResponse, context.swap, context.originAsset);
  return {
    embeds: [statusUpdateEmbed(statusResponse, context)],
    components: fixedFloatRecoveryAvailable(statusResponse)
      ? [new ActionRowBuilder().addComponents(
        ...(!statusResponse.emergency.reasons.includes('LIMIT') ? [new ButtonBuilder().setCustomId(componentId(ticketId, 'ff-exchange')).setLabel('Exchange received funds').setStyle(ButtonStyle.Primary)] : []),
        new ButtonBuilder().setCustomId(componentId(ticketId, 'ff-refund')).setLabel('Refund minus network fee').setStyle(ButtonStyle.Danger),
      )]
      : terminal
      ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(componentId(ticketId, 'close')).setLabel('Close ticket').setEmoji('✖️').setStyle(ButtonStyle.Danger),
      )]
      : incompleteDeposit && context.swap?.deposit_address
        ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(componentId(ticketId, 'show-incomplete-deposit'))
            .setLabel('Copy details')
            .setEmoji('📋')
            .setStyle(ButtonStyle.Secondary),
        )]
        : [],
  };
}

function swapDeadlineUnix(swap) {
  const milliseconds = new Date(swap?.quote_deadline ?? Number.NaN).getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function incompleteDepositRefundTiming(deadline) {
  const timing = deadline === null
    ? 'the funding deadline shown in the main swap message'
    : `<t:${deadline}:F> (<t:${deadline}:R>)`;
  return `If no more funds arrive by ${timing}, the deposited funds will begin returning to your configured refund address. Refund arrival may take additional network processing time.`;
}

export function incompleteDepositDetails(statusResponse, swap, originAsset) {
  if (statusResponse?.provider === 'fixedfloat' || swap?.executable_quote?.provider === 'fixedfloat') return null;
  if (statusResponse?.status !== 'INCOMPLETE_DEPOSIT' || !swap || !originAsset) return null;
  const required = firstUnsignedInteger(swap.executable_quote?.quote?.amountIn, swap.amount_base);
  const deposited = firstUnsignedInteger(statusResponse.swapDetails?.depositedAmount);
  if (required === null || required <= 0n || deposited === null || deposited >= required) return null;
  if (!Number.isInteger(originAsset.decimals) || originAsset.decimals < 0) return null;
  const remainingFormatted = fromBaseUnits((required - deposited).toString(), originAsset.decimals);
  if (remainingFormatted === 'n/a') return null;
  return {
    remainingFormatted,
    symbol: originAsset.symbol,
    network: networkLabel(originAsset.blockchain),
  };
}

function firstUnsignedInteger(...values) {
  for (const value of values) {
    const input = String(value ?? '').trim();
    if (/^\d+$/.test(input)) return BigInt(input);
  }
  return null;
}

export function payoutSentPayload(userId, swap, statusResponse, catalogue) {
  const details = statusResponse?.swapDetails ?? {};
  const destination = catalogue.getAsset(swap.destination_asset_id);
  const amount = firstPopulatedValue(
    details.amountOutFormatted,
    swap.executable_quote?.quote?.amountOutFormatted,
  );
  const amountLabel = amount && destination?.symbol
    ? ` of \`${safeCode(amount)} ${safeCode(destination.symbol)}\``
    : '';
  const content = `<@${userId}> Your payout${amountLabel} has been sent to your receiving wallet. This ticket will close automatically after the transaction is confirmed.`;
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('Payout sent')
    .setDescription('The destination transfer has been submitted successfully. Confirmation tracking is continuing automatically.')
    .setTimestamp(new Date(statusResponse?.updatedAt ?? Date.now()));
  const transactions = details.destinationChainTxHashes ?? [];
  const link = transactions.map((transaction) => safeExplorerLink(transaction?.explorerUrl)).find(isUnbrandedExplorerLink);
  if (link) {
    embed.addFields({
      name: 'Destination transaction',
      value: `[View on ${safeCode(link.hostname)}](${link.url})`,
    });
  }
  return {
    content,
    embeds: [embed],
    components: [],
    allowedMentions: { users: [String(userId)] },
  };
}

export function payoutClosingPayload(userId, swap, statusResponse, catalogue, ticketId, deleteAt) {
  const payload = payoutSentPayload(userId, swap, statusResponse, catalogue);
  const unix = Math.floor(new Date(deleteAt).getTime() / 1000);
  payload.content = `${payload.content.replace(' This ticket will close automatically after the transaction is confirmed.', '')} This ticket will be deleted <t:${unix}:F> (<t:${unix}:R>) unless you close it first.`;
  payload.embeds[0]
    .setTitle('Swap completed')
    .setDescription('The destination transfer has been broadcast to your receiving wallet. No further action is required.');
  payload.components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(componentId(ticketId, 'close'))
      .setLabel('Close ticket')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger),
  )];
  return payload;
}

export function userStatsPayload(userStats, user = null) {
  const stats = normalizedUserStats(userStats);
  const displayName = safeUserDisplayName(user);
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(displayName ? `${displayName}'s swap stats` : 'Swap stats')
    .addFields(
      { name: 'Total exchanged', value: formatUsd(stats.totalAmountUsd), inline: true },
      { name: 'Fees saved vs. 1%', value: formatUsd(stats.feesSavedUsd), inline: true },
      { name: 'Completed swaps', value: stats.completedSwapCount, inline: true },
    );
  return { embeds: [embed], components: [] };
}

export function leaderboardPayload(entries) {
  const rows = entries.slice(0, 5).map((entry, index) => {
    const name = safeUserMention(entry.user_id);
    const count = String(entry.completed_swap_count ?? '0');
    const swapLabel = count === '1' ? 'swap' : 'swaps';
    return `**${index + 1}. ${name}**\n${formatUsd(entry.total_amount_usd)} exchanged • ${safeCode(count)} ${swapLabel}`;
  });
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('Server swap leaderboard')
    .setDescription(rows.length > 0
      ? rows.join('\n\n')
      : 'No completed swaps have been recorded yet.');
  return { embeds: [embed], components: [] };
}

function normalizedUserStats(userStats) {
  const completedSwapCount = String(userStats?.completed_swap_count ?? '0');
  return {
    completedSwapCount: /^\d+$/.test(completedSwapCount) ? completedSwapCount : '0',
    totalAmountUsd: userStats?.total_amount_usd ?? '0',
    feesSavedUsd: userStats?.fees_saved_usd ?? '0',
  };
}

function safeUserDisplayName(user) {
  const value = user?.display_name ?? user?.globalName ?? user?.username;
  if (!value) return null;
  return safeCode(value).slice(0, 80);
}

function safeUserMention(userId) {
  const value = String(userId ?? '');
  return /^\d{17,20}$/.test(value) ? `<@${value}>` : `User ${safeCode(value.slice(-6))}`;
}

function safeExplorerLink(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return {
      hostname: url.hostname,
      url: url.toString().replaceAll('(', '%28').replaceAll(')', '%29'),
    };
  } catch {
    return null;
  }
}

function isNonZeroFormattedAmount(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return false;
  const numeric = Number(normalized);
  return !Number.isFinite(numeric) || numeric !== 0;
}

function finalizedSettlementAmounts(swap, destinationAsset) {
  const quote = swap.executable_quote?.quote ?? {};
  const details = swap.last_status_response?.swapDetails ?? {};
  return {
    amountInFormatted: firstPopulatedValue(
      details.depositedAmountFormatted,
      details.amountInFormatted,
      quote.amountInFormatted,
      swap.amount_display,
      'n/a',
    ),
    amountOutFormatted: exactFormattedAmount(details.amountOut, destinationAsset?.decimals)
      ?? firstPopulatedValue(details.amountOutFormatted, quote.amountOutFormatted, 'n/a'),
    amountInUsd: firstPopulatedValue(
      ['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap.executable_quote?.provider) ? details.amountInUsd : null,
      quote.amountInUsd,
      details.depositedAmountUsd,
      details.amountInUsd,
      swap.amount_usd_requested,
    ),
    amountOutUsd: firstPopulatedValue(['changenow', 'changelly', 'fixedfloat', 'relay'].includes(swap.executable_quote?.provider) ? details.amountOutUsd : null, quote.amountOutUsd, details.amountOutUsd),
  };
}

function isUnbrandedExplorerLink(link) {
  return Boolean(link) && !link.hostname.toLowerCase().endsWith('near-intents.org');
}

function exactFormattedAmount(value, decimals) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isInteger(decimals)) return null;
  const formatted = fromBaseUnits(value, decimals);
  return formatted === 'n/a' ? null : formatted;
}

function firstPopulatedValue(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

function fixedFloatRecoveryAvailable(response) {
  return response.provider === 'fixedfloat' && response.providerStatus === 'EMERGENCY'
    && response.emergency?.choice === 'NONE' && response.emergency?.reasons?.includes('LESS') && !response.emergency.repeat;
}
