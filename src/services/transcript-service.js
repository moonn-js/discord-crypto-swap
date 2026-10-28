const MAX_TRANSCRIPT_PART_BYTES = 7_000_000;
const MAX_TRANSCRIPT_PARTS = 10;

export function buildTranscriptFiles({ ticket, swap, messages, closedAt = new Date() }) {
  const title = `Swap ticket ${ticket.id}`;
  const metadata = renderMetadata(ticket, swap, closedAt);
  const messageSections = messages
    .slice()
    .sort((left, right) => messageTime(left) - messageTime(right))
    .map(renderMessage);
  const groups = splitSections(messageSections, MAX_TRANSCRIPT_PART_BYTES, metadata, title);
  if (groups.length > MAX_TRANSCRIPT_PARTS) {
    throw new Error(`Transcript requires ${groups.length} files, exceeding Discord's attachment limit.`);
  }

  return groups.map((sections, index) => {
    const suffix = groups.length === 1 ? '' : `-${index + 1}-of-${groups.length}`;
    const document = renderDocument({
      title: groups.length === 1 ? title : `${title} — part ${index + 1} of ${groups.length}`,
      metadata,
      sections,
    });
    return {
      attachment: Buffer.from(document, 'utf8'),
      name: `swap-ticket-${ticket.id}${suffix}.txt`,
    };
  });
}

export async function fetchAllChannelMessages(channel) {
  const collected = [];
  let before;
  while (true) {
    const page = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
    const messages = [...page.values()];
    collected.push(...messages);
    if (messages.length < 100) break;
    const oldest = messages.reduce((candidate, message) => (
      !candidate || messageTime(message) < messageTime(candidate) ? message : candidate
    ), null);
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
  }
  return collected.sort((left, right) => messageTime(left) - messageTime(right));
}

function renderDocument({ title, metadata, sections }) {
  return `${title}
${'='.repeat(title.length)}

Ticket details
--------------
${metadata}

Messages
--------
${sections.join('\n\n') || 'No messages were found in the ticket channel.'}
`;
}

function renderMetadata(ticket, swap, closedAt) {
  const rows = [
    ['Ticket owner', `${ticket.user_id}`],
    ['Ticket ID', ticket.id],
    ['Final status', swap.status],
    ['Closure reason', ticket.closure_reason ?? 'TERMINAL'],
    ['Opened at', iso(ticket.created_at)],
    ['Finalized at', iso(swap.terminal_at ?? swap.tracking_stale_at ?? swap.updated_at)],
    ['Scheduled deletion at', iso(ticket.delete_at)],
    ['Transcript generated at', iso(closedAt)],
    ['Origin asset', swap.origin_asset_id],
    ['Destination asset', swap.destination_asset_id],
    ['Amount', swap.amount_display],
    ['Recipient wallet', swap.recipient],
    ['Refund wallet', swap.refund_to],
    ['Deposit address', swap.deposit_address],
    ['Deposit memo', swap.deposit_memo],
    ['Deposit transaction', swap.deposit_tx_hash],
  ];
  return rows.map(([label, value]) => renderLabel(label, value ?? '—')).join('\n');
}

function renderMessage(message) {
  const author = message.author ?? {};
  const authorName = author.globalName ?? author.displayName ?? author.username ?? author.tag ?? 'Unknown author';
  const authorId = author.id ? ` (${author.id})` : '';
  const sections = [`[${iso(message.createdAt ?? message.createdTimestamp)}] ${plainText(authorName)}${authorId}`];
  if (message.content) sections.push(`Content:\n${indent(message.content)}`);
  sections.push(...(message.embeds ?? []).map((embed) => renderEmbed(embed.toJSON?.() ?? embed)));
  const attachments = [...(message.attachments?.values?.() ?? [])]
    .map(renderAttachment)
    .filter(Boolean);
  if (attachments.length > 0) sections.push(`Attachments:\n${attachments.map((attachment) => `  - ${attachment}`).join('\n')}`);
  return sections.join('\n');
}

function renderEmbed(embed) {
  const lines = ['Embed:'];
  if (embed.title) lines.push(indent(renderLabel('Title', embed.title)));
  if (embed.description) lines.push(indent(renderLabel('Description', embed.description)));
  for (const field of embed.fields ?? []) lines.push(indent(renderLabel(field.name, field.value)));
  if (embed.footer?.text) lines.push(indent(renderLabel('Footer', embed.footer.text)));
  return lines.join('\n');
}

function renderAttachment(attachment) {
  const url = safeHttpsUrl(attachment.url);
  const name = plainText(attachment.name ?? 'attachment');
  if (!url) return `${name} (unsafe or unavailable link omitted)`;
  return `${name}: ${url}`;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function splitSections(sections, maxBytes, metadata, title) {
  const groups = [[]];
  const documentOverhead = Buffer.byteLength(renderDocument({ title, metadata, sections: [] }), 'utf8');
  let currentBytes = documentOverhead;
  for (const section of sections) {
    const current = groups.at(-1);
    const sectionBytes = Buffer.byteLength(section, 'utf8') + 1;
    if (current.length > 0 && currentBytes + sectionBytes > maxBytes) {
      groups.push([section]);
      currentBytes = documentOverhead + sectionBytes;
    } else {
      current.push(section);
      currentBytes += sectionBytes;
    }
  }
  return groups;
}

function renderLabel(label, value) {
  const normalizedLabel = plainText(label);
  const normalizedValue = plainText(value);
  return `${normalizedLabel}: ${normalizedValue.replaceAll('\n', `\n${' '.repeat(normalizedLabel.length + 2)}`)}`;
}

function indent(value) {
  return plainText(value).split('\n').map((line) => `  ${line}`).join('\n');
}

function plainText(value) {
  return String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function messageTime(message) {
  return new Date(message.createdAt ?? message.createdTimestamp ?? 0).getTime();
}

function iso(value) {
  if (value == null) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
