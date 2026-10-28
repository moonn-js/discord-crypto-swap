import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
} from 'discord.js';

export const GUILD_SETUP_STEPS = Object.freeze([
  Object.freeze({
    key: 'panelChannelId',
    label: 'Swap panel',
    prompt: 'Select the text channel where the public swap panel should be posted.',
    channelTypes: Object.freeze([ChannelType.GuildText]),
    optional: false,
  }),
  Object.freeze({
    key: 'ticketCategoryId',
    label: 'Ticket category',
    prompt: 'Select the category where private swap ticket channels should be created.',
    channelTypes: Object.freeze([ChannelType.GuildCategory]),
    optional: false,
  }),
  Object.freeze({
    key: 'completedDealsChannelId',
    label: 'Completed swaps',
    prompt: 'Select the channel for completed-swap summaries, or choose None.',
    channelTypes: Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    optional: true,
  }),
  Object.freeze({
    key: 'transcriptChannelId',
    label: 'Ticket logs',
    prompt: 'Select the channel for final ticket transcript files, or choose None.',
    channelTypes: Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    optional: true,
  }),
  Object.freeze({
    key: 'vouchChannelId',
    label: 'Vouches',
    prompt: 'Select the channel members should be directed to for vouches, or choose None.',
    channelTypes: Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    optional: true,
  }),
]);

export function setupRedoConfirmationPayload(sessionId) {
  return {
    content: '**This server is already configured.** Redoing setup will replace its channel settings. Nothing will change until the new setup is completed and saved.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(setupComponentId(sessionId, 'redo'))
        .setLabel('Redo Setup')
        .setStyle(ButtonStyle.Danger),
      cancelButton(sessionId),
    )],
    allowedMentions: { parse: [] },
  };
}

export function setupStepPayload(sessionId, stepIndex, values = {}) {
  const step = GUILD_SETUP_STEPS[stepIndex];
  if (!step) throw new RangeError('Unknown setup step.');

  const selection = new ChannelSelectMenuBuilder()
    .setCustomId(setupComponentId(sessionId, 'select'))
    .setPlaceholder(`Select ${step.label.toLowerCase()}`)
    .setChannelTypes(...step.channelTypes)
    .setMinValues(1)
    .setMaxValues(1);
  const buttons = [];
  if (stepIndex > 0) {
    buttons.push(new ButtonBuilder()
      .setCustomId(setupComponentId(sessionId, 'back'))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary));
  }
  if (step.optional) {
    buttons.push(new ButtonBuilder()
      .setCustomId(setupComponentId(sessionId, 'none'))
      .setLabel('None')
      .setStyle(ButtonStyle.Secondary));
  }
  buttons.push(cancelButton(sessionId));

  const current = Object.hasOwn(values, step.key)
    ? `\nCurrent choice: ${values[step.key] ? `<#${values[step.key]}>` : 'None'}`
    : '';
  return {
    content: `**Setup ${stepIndex + 1}/${GUILD_SETUP_STEPS.length} — ${step.label}**\n${step.prompt}${current}`,
    components: [
      new ActionRowBuilder().addComponents(selection),
      new ActionRowBuilder().addComponents(...buttons),
    ],
    allowedMentions: { parse: [] },
  };
}

export function setupReviewPayload(sessionId, values) {
  const lines = GUILD_SETUP_STEPS.map((step) => (
    `**${step.label}:** ${values[step.key] ? `<#${values[step.key]}>` : 'None'}`
  ));
  return {
    content: `**Review server setup**\n${lines.join('\n')}\n\nNothing changes until you press **Save Setup**.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(setupComponentId(sessionId, 'back'))
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(setupComponentId(sessionId, 'save'))
        .setLabel('Save Setup')
        .setStyle(ButtonStyle.Success),
      cancelButton(sessionId),
    )],
    allowedMentions: { parse: [] },
  };
}

export function setupSavedPayload(values) {
  const lines = GUILD_SETUP_STEPS.map((step) => (
    `**${step.label}:** ${values[step.key] ? `<#${values[step.key]}>` : 'None'}`
  ));
  return {
    content: `**Setup saved.**\n${lines.join('\n')}\n\nThe swap panel is ready.`,
    components: [],
    allowedMentions: { parse: [] },
  };
}

export function parseSetupComponentId(value) {
  const match = /^setup:([0-9a-f-]{36}):(redo|select|back|none|save|cancel)$/.exec(String(value));
  return match ? { sessionId: match[1], action: match[2] } : null;
}

function setupComponentId(sessionId, action) {
  return `setup:${sessionId}:${action}`;
}

function cancelButton(sessionId) {
  return new ButtonBuilder()
    .setCustomId(setupComponentId(sessionId, 'cancel'))
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);
}
