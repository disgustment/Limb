const fs = require('fs')
const path = require('path')
const http = require('http')
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder
} = require('discord.js')

const { GoogleGenAI } = require('@google/genai')
const eco = require('./economy')

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err?.message || err)
})

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err?.message || err)
})

const TOKEN = process.env.DISCORD_TOKEN
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const PORT = process.env.PORT || 3000

const VERIFIED_ROLE = '1487219839511822530'
const UNVERIFIED_ROLE = '1474472690831327375'
const MOD_CHANNEL = '1488045222301794344'
const STAFF_ROLE = '1474213205378339020'
const TICKET_CATEGORY = '1474929234664231073'
const TICKET_PANEL_CHANNEL = '1487956293736988753'
const WELCOME_CHANNEL = '1487993335519117465'
const RULES_CHANNEL = '1474932410763186306'
const VERIFY_CHANNEL = '1487211537335849081'
const VOICEMASTER_MENU_CHANNEL = '1488017411168010340'
const VOICEMASTER_CREATE_CHANNEL = '1488017412736680037'

const REFRESH_INTERVAL = 10000
const MESSAGE_CACHE_TTL = 15000
const CHAT_SESSION_MS = 15 * 60 * 1000
const MAX_MEMORY = 16
const DASHBOARD_PAGE_SIZE = 4

const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null

const requests = new Map()
const processedMessages = new Set()
const memoryStore = new Map()
const chatSessions = new Map()
const openTickets = new Map()
const tempVoiceOwners = new Map()
const userOwnedTempChannels = new Map()

let queueMessageId = null
let dashboardStarted = false
let dashboardUpdating = false
let verificationLogMessageId = null
let dashboardPage = 0

const LOCK_FILE = path.join('/tmp', 'limb-bot.lock')

function acquireProcessLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10)

      if (!Number.isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0)
          console.log(`Another bot instance is already running with PID ${existingPid}. Exiting this one.`)
          process.exit(0)
        } catch {
          fs.unlinkSync(LOCK_FILE)
        }
      } else {
        fs.unlinkSync(LOCK_FILE)
      }
    }

    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8')

    const cleanup = () => {
      try {
        if (fs.existsSync(LOCK_FILE)) {
          const pidInFile = fs.readFileSync(LOCK_FILE, 'utf8').trim()
          if (pidInFile === String(process.pid)) {
            fs.unlinkSync(LOCK_FILE)
          }
        }
      } catch {}
    }

    process.on('exit', cleanup)
    process.on('SIGINT', () => {
      cleanup()
      process.exit(0)
    })
    process.on('SIGTERM', () => {
      cleanup()
      process.exit(0)
    })
  } catch (err) {
    console.error('Failed to acquire process lock:', err?.message || err)
    process.exit(1)
  }
}

acquireProcessLock()

const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    ok: true,
    service: 'limb-bot',
    time: new Date().toISOString()
  }))
})

healthServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Health server port ${PORT} is already in use. Skipping health server on this process.`)
    return
  }
  console.error('Health server error:', err?.message || err)
})

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on ${PORT}`)
})

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
})

function rememberMessage(messageId) {
  processedMessages.add(messageId)
  setTimeout(() => processedMessages.delete(messageId), MESSAGE_CACHE_TTL)
}

function stripBotMention(content, botId) {
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
}

function getStatusEmoji(status, position) {
  if (status === 'approved') return '✅'
  if (status === 'denied') return '❌'
  return position === 0 ? '🔹' : '🕒'
}

function getMemory(userId) {
  if (!memoryStore.has(userId)) memoryStore.set(userId, [])
  return memoryStore.get(userId)
}

function pushMemory(userId, role, content) {
  const memory = getMemory(userId)
  memory.push({ role, content, at: Date.now() })
  if (memory.length > MAX_MEMORY) {
    memory.splice(0, memory.length - MAX_MEMORY)
  }
}

function sessionKey(message) {
  return `${message.guildId || 'dm'}:${message.channel.id}:${message.author.id}`
}

function getSession(message) {
  const key = sessionKey(message)
  const session = chatSessions.get(key)
  if (!session) return null

  if (Date.now() - session.lastActive > CHAT_SESSION_MS) {
    chatSessions.delete(key)
    return null
  }

  return session
}

function touchSession(message, botMessageId = null) {
  const key = sessionKey(message)
  const session = getSession(message) || {}
  session.lastActive = Date.now()
  if (botMessageId) session.lastBotMessageId = botMessageId
  chatSessions.set(key, session)
}

function endSession(message) {
  chatSessions.delete(sessionKey(message))
}

function isReplyToBot(message) {
  return Boolean(
    message.reference?.messageId &&
    message.mentions?.repliedUser &&
    message.mentions.repliedUser.id === client.user.id
  )
}

function shouldTriggerBotChat(message, cmd, content) {
  const mentioned = message.mentions.has(client.user)
  const replied = isReplyToBot(message)
  const session = getSession(message)
  const isTalkCommand = cmd === '%talk'
  const isStopCommand = cmd === '%stop' || cmd === '%bye'

  if (isStopCommand) {
    return { should: true, stop: true, input: '' }
  }

  if (isTalkCommand) {
    return { should: true, stop: false, input: content.slice(5).trim() }
  }

  if (mentioned) {
    return {
      should: true,
      stop: false,
      input: stripBotMention(content, client.user.id)
    }
  }

  if (replied) {
    return { should: true, stop: false, input: content }
  }

  if (session) {
    return { should: true, stop: false, input: content }
  }

  return { should: false, stop: false, input: '' }
}

function hasStaffAccess(member) {
  return Boolean(
    member &&
    (
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      (STAFF_ROLE && member.roles.cache.has(STAFF_ROLE))
    )
  )
}

function getPendingRequestsArray() {
  return Array.from(requests.entries()).filter(([, info]) => info.status === 'pending')
}

function getDashboardPageCount() {
  return Math.max(1, Math.ceil(getPendingRequestsArray().length / DASHBOARD_PAGE_SIZE))
}

function clampDashboardPage() {
  const pageCount = getDashboardPageCount()
  if (dashboardPage < 0) dashboardPage = 0
  if (dashboardPage > pageCount - 1) dashboardPage = pageCount - 1
}

function buildHelpHomeEmbed() {
  return new EmbedBuilder()
    .setColor(0x00E5FF)
    .setTitle('Limb Bot')
    .setDescription(
      'use the menu below to navigate commands\n\n' +
      '**core systems**\n' +
      'moderation, tickets, voicemaster\n\n' +
      '**extras**\n' +
      'economy, fun, utilities'
    )
    .addFields(
      {
        name: 'main',
        value: [
          'moderation',
          'tickets',
          'voicemaster'
        ].join('\n'),
        inline: true
      },
      {
        name: 'other',
        value: [
          'economy',
          'fun',
          'information',
          'config'
        ].join('\n'),
        inline: true
      },
      {
        name: 'quick access',
        value:
          `support <#${TICKET_PANEL_CHANNEL}>\n` +
          `rules <#${RULES_CHANNEL}>\n` +
          `verify <#${VERIFY_CHANNEL}>`
      }
    )
    .setFooter({ text: 'select a category below' })
}
function buildHelpCategoryEmbed(category) {
  const embed = new EmbedBuilder()
    .setColor(0x00E5FF)
    .setFooter({ text: 'select a category below' })

  if (category === 'moderation') {
    return embed
      .setTitle('Moderation')
      .setDescription([
        '`!setup` posts the verification panel',
        '`!verify-refresh` refreshes the verification dashboard',
        '`!mod-setup` rebuilds the dashboard and latest action log',
        'use the dashboard buttons to view, approve, deny, refresh, and page through requests'
      ].join('\n'))
  }

  if (category === 'economy') {
    return embed
      .setTitle('Economy')
      .setDescription([
        '`%bal [@user]`',
        '`%daily`',
        '`%work`',
        '`%pay @user <amount>`',
        '`%lb`',
        '`%slots <amount>`',
        '`%coinflip <heads/tails> <amount>`'
      ].join('\n'))
  }

  if (category === 'information') {
    return embed
      .setTitle('Information')
      .setDescription([
        '`%help` opens this help menu',
        '`!testwelcome [@user]` sends a welcome test',
        `welcome channel: <#${WELCOME_CHANNEL}>`,
        `rules channel: <#${RULES_CHANNEL}>`
      ].join('\n'))
  }

  if (category === 'fun') {
    return embed
      .setTitle('Fun')
      .setDescription([
        '`%talk <message>` starts a conversation',
        '`@BotName <message>` also starts one',
        '`%stop` ends the current conversation',
        'reply to the bot to keep chatting'
      ].join('\n'))
  }

  if (category === 'config') {
    return embed
      .setTitle('Config')
      .setDescription([
        '`!setup` verification setup',
        '`!ticket-setup` ticket setup',
        '`!voicemaster-setup` voicemaster setup',
        '`!verify-refresh` dashboard refresh',
        '`!mod-setup` moderation system rebuild'
      ].join('\n'))
  }

  if (category === 'tickets') {
    return embed
      .setTitle('Tickets')
      .setDescription([
        '`!ticket-setup` posts the support panel',
        'click **Open a Ticket** to create a private channel',
        'click **🔒 Close Ticket** inside to close it',
        `panel channel: <#${TICKET_PANEL_CHANNEL}>`
      ].join('\n'))
  }

  if (category === 'voicemaster') {
    return embed
      .setTitle('Voicemaster')
      .setDescription([
        '`!voicemaster-setup` posts the voice menu panel',
        `join <#${VOICEMASTER_CREATE_CHANNEL}> to create your own voice`,
        'use the menu buttons to rename, set limit, lock, unlock, hide, show, or claim'
      ].join('\n'))
  }

  return buildHelpHomeEmbed()
}

function buildHelpComponents(guildId) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('help_category_select')
    .setPlaceholder('Choose a help category')
    .addOptions(
      { label: 'Moderation', value: 'moderation', description: 'verification and staff tools' },
      { label: 'Economy', value: 'economy', description: 'coins and games' },
      { label: 'Information', value: 'information', description: 'welcome and info commands' },
      { label: 'Fun', value: 'fun', description: 'chat features' },
      { label: 'Config', value: 'config', description: 'setup commands' },
      { label: 'Tickets', value: 'tickets', description: 'support system' },
      { label: 'Voicemaster', value: 'voicemaster', description: 'temporary voice system' }
    )

  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`
  const supportUrl = guildId ? `https://discord.com/channels/${guildId}/${TICKET_PANEL_CHANNEL}` : 'https://discord.gg/limb'
  const communityUrl = 'https://discord.gg/limb'

  const row1 = new ActionRowBuilder().addComponents(select)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Invite')
      .setURL(inviteUrl),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Support')
      .setURL(supportUrl),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Discord')
      .setURL(communityUrl)
  )

  return [row1, row2]
}

function buildSetupEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🛡️ Verification Center')
    .setDescription('Press the button below to request verification. Staff will review your request shortly.')
    .setFooter({ text: 'Limb Bot • Verification' })
    .setTimestamp()
}

function buildBalanceEmbed(target, balance) {
  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`💰 ${target.username}'s Balance`)
    .setThumbnail(target.displayAvatarURL({ dynamic: true }))
    .setDescription(`**${balance.toLocaleString()} coins**`)
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildDailyEmbed(amount, balance) {
  return new EmbedBuilder()
    .setColor(0x00FF99)
    .setTitle('📅 Daily Reward Claimed')
    .setDescription(`You received **${amount.toLocaleString()} coins**.\nNew balance: **${balance.toLocaleString()} coins**`)
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildWorkEmbed(job, amount, balance) {
  return new EmbedBuilder()
    .setColor(0x00BFFF)
    .setTitle('💼 Work Complete')
    .setDescription(`You **${job}** and earned **${amount.toLocaleString()} coins**.\nNew balance: **${balance.toLocaleString()} coins**`)
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildPayEmbed(sender, target, amount) {
  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('💸 Transfer Complete')
    .setDescription(`**${sender.username}** sent **${amount.toLocaleString()} coins** to **${target.username}**`)
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildLeaderboardEmbed(lines) {
  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🏆 Richest Members')
    .setDescription(lines.length ? lines.join('\n') : 'No data yet.')
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildSlotsEmbed(reels, result, changeText, balance, won) {
  return new EmbedBuilder()
    .setColor(won ? 0x00FF99 : 0xFF4444)
    .setTitle('🎰 Slot Machine')
    .setDescription(`${reels.join(' | ')}\n\n${result}\n${changeText}\nBalance: **${balance.toLocaleString()} coins**`)
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildCoinflipEmbed(playerPick, flip, amount, balance, won) {
  return new EmbedBuilder()
    .setColor(won ? 0x00FF99 : 0xFF4444)
    .setTitle(`🪙 Coin Flip • ${flip === 'heads' ? '🪙 Heads' : '🔵 Tails'}`)
    .setDescription(
      `You chose **${playerPick}**.\nIt landed on **${flip}**.\n${won ? `✅ You won **${amount.toLocaleString()} coins**.` : `❌ You lost **${amount.toLocaleString()} coins**.`}\nBalance: **${balance.toLocaleString()} coins**`
    )
    .setFooter({ text: 'Limb Bot • Economy' })
    .setTimestamp()
}

function buildUserInfoEmbed(user, nickname, createdAt, joinedAt, roles, avatarUrl) {
  return new EmbedBuilder()
    .setColor(0x00FFFF)
    .setTitle(`👤 User Info • ${user.username}`)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: 'Nickname', value: nickname, inline: true },
      { name: 'Created', value: createdAt, inline: true },
      { name: 'Joined', value: joinedAt, inline: true },
      { name: 'Roles', value: roles, inline: false }
    )
    .setFooter({ text: 'Limb Bot • Staff View' })
    .setTimestamp()
}

function buildDashboardEmbed(sortedRequests, page, pageCount, totalPending) {
  const embed = new EmbedBuilder()
    .setColor(0x00E5FF)
    .setTitle('Verification Queue')
    .setDescription(`pending: **${totalPending}**`)
    .addFields({
      name: 'navigation',
      value: `page **${page + 1}** of **${pageCount}**`
    })
    .setFooter({ text: 'use the buttons below to manage the queue' })
    .setTimestamp()

  if (!sortedRequests.length) {
    embed.addFields({
      name: 'queue',
      value: 'empty'
    })
    return embed
  }

  for (let i = 0; i < sortedRequests.length; i++) {
    const [, info] = sortedRequests[i]
    embed.addFields({
      name: `#${page * DASHBOARD_PAGE_SIZE + i + 1} ${info.user.username}`,
      value: info.summaryText || 'loading...'
    })
  }

  return embed
}

function buildVerificationLogEmbed(userId, status, reason = null, moderatorTag = 'Unknown') {
  const color = status === 'approved' ? 0x57F287 : 0xED4245
  const action = status === 'approved' ? 'Approved' : 'Denied'

  const lines = [
    userId === 'none' ? 'User: **none yet**' : `User: <@${userId}>`,
    `Moderator: **${moderatorTag}**`
  ]

  if (reason) lines.push(`Reason: **${reason}**`)

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Latest Verification Action • ${action}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Limb Bot • Verification Log' })
    .setTimestamp()
}

function buildTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Open a Support Ticket')
    .setDescription(
      '> **Please only open a ticket if you genuinely need help.**\n\n' +
      'This is not a place for casual conversation. Tickets are for real issues only.\n\n' +
      '**What counts as a valid ticket:**\n' +
      '• You have a question staff need to answer privately\n' +
      '• You need help with something in the server\n' +
      '• You want to report a user or issue\n\n' +
      'A member of the team will get back to you as soon as possible.\n' +
      'Click the button below to get started.'
    )
    .setFooter({ text: 'Limb Bot • Support' })
    .setTimestamp()
}

function buildTicketWelcomeEmbed(user) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Ticket Opened')
    .setDescription(
      `Welcome, <@${user.id}>.\n\n` +
      'A staff member will be with you shortly. Please be patient.\n\n' +
      '**While you wait:**\n' +
      '• Describe your issue clearly in one message\n' +
      '• Include any relevant details or screenshots\n' +
      '• Do not ping staff\n\n' +
      'When your issue is resolved, click **🔒 Close Ticket** below.'
    )
    .setFooter({ text: 'Limb Bot • Support' })
    .setTimestamp()
}

function buildTicketCloseConfirmEmbed() {
  return new EmbedBuilder()
    .setColor(0xFF4444)
    .setTitle('🔒 Close Ticket')
    .setDescription('Are you sure you want to close this ticket? The channel will be deleted.')
    .setFooter({ text: 'Limb Bot • Ticket System' })
    .setTimestamp()
}

function buildWelcomeEmbed(member) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('**Welcome to Limb!**')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription(
      `hey **${member.user.username}**, welcome to **Limb**\n\n` +
      `> support: <#${TICKET_PANEL_CHANNEL}>\n` +
      `> rules: <#${RULES_CHANNEL}>\n` +
      `> verify: <#${VERIFY_CHANNEL}>\n\n` +
      'Enjoy your stay at Limb and make yourself at home..'
    )
    .setFooter({ text: 'Limb • Welcome' })
    .setTimestamp()
}

function buildVoiceMasterPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔊 VoiceMaster')
    .setDescription(
      `join <#${VOICEMASTER_CREATE_CHANNEL}> to create your own voice channel.\n\n` +
      '**controls**\n' +
      'rename, limit, lock, unlock, hide, show, claim\n\n' +
      'stand in your temp channel first, then use the buttons below.'
    )
    .setFooter({ text: 'Limb Bot • VoiceMaster' })
    .setTimestamp()
}

function buildVoiceMasterRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vm_rename').setLabel('Rename').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('vm_limit').setLabel('Limit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('vm_claim').setLabel('Claim').setStyle(ButtonStyle.Success)
  )

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vm_lock').setLabel('Lock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vm_unlock').setLabel('Unlock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vm_hide').setLabel('Hide').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vm_show').setLabel('Show').setStyle(ButtonStyle.Secondary)
  )

  return [row1, row2]
}

function buildDashboardComponents(page, pageCount, visible) {
  const rows = []

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('verify_prev')
        .setLabel('⬅️ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId('verify_refresh')
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('verify_next')
        .setLabel('Next ➡️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1)
    )
  )

  for (const [userId, info] of visible) {
    if (info.status === 'pending') {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`view_${userId}`)
            .setLabel('View')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`approve_${userId}`)
            .setLabel('Approve')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`deny_${userId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger)
        )
      )
    }
  }

  return rows
}

async function sendWelcomeEmbed(member) {
  try {
    const channel = member.guild.channels.cache.get(WELCOME_CHANNEL)
      || await member.guild.channels.fetch(WELCOME_CHANNEL).catch(() => null)

    if (!channel || !channel.isTextBased()) {
      console.error(`Welcome channel ${WELCOME_CHANNEL} not found or not text based.`)
      return
    }

    await channel.send({
      embeds: [buildWelcomeEmbed(member)]
    })
  } catch (err) {
    console.error('Failed to send welcome embed:', err?.message || err)
  }
}

async function buildGeminiReply(userId, input) {
  if (!gemini) return null

  const memory = getMemory(userId)
  const historyText = memory
    .map(entry => `${entry.role === 'user' ? 'User' : 'Bot'}: ${entry.content}`)
    .join('\n')

  const prompt = [
    'You are Limb Bot in a Discord server.',
    'Your personality is cute, warm, playful, affectionate, and a little teasing in a harmless way.',
    'Type like a real online girl texting casually.',
    'Use lowercase most of the time.',
    'Use soft internet style sometimes, like "ngl", "idk", "tbh", "pls", "rn", and ":3" when it fits naturally.',
    'Do not overdo ":3". Use it lightly.',
    'Do not sound robotic, formal, or scripted.',
    'Be emotionally aware and make your replies actually fit what the user said.',
    'Be sweet when the user is vulnerable.',
    'Be playful when the mood is light.',
    'Be serious when the topic is serious.',
    'Keep most replies between 1 and 4 sentences unless the user asks for more.',
    'Do not mention ai, prompts, system instructions, or safety policy.',
    'Do not be sexual.',
    '',
    historyText,
    '',
    `User: ${input}`,
    'Bot:'
  ].join('\n')

  const response = await gemini.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt
  })

  const text = response.text?.trim()
  return text || null
}

async function postVerificationActionLog(userId, status, moderatorTag, reason = null) {
  try {
    const modChannel = client.channels.cache.get(MOD_CHANNEL)
      || await client.channels.fetch(MOD_CHANNEL).catch(() => null)

    if (!modChannel || !modChannel.isTextBased()) return

    const embed = buildVerificationLogEmbed(userId, status, reason, moderatorTag)

    if (verificationLogMessageId) {
      const existing = await modChannel.messages.fetch(verificationLogMessageId).catch(() => null)
      if (existing) {
        await existing.edit({ embeds: [embed], content: '' })
        return
      }
    }

    const sent = await modChannel.send({ embeds: [embed] })
    verificationLogMessageId = sent.id
  } catch (err) {
    console.error('Failed to post verification action log:', err?.message || err)
  }
}

function getOwnedVoiceChannelForUser(userId, guild) {
  const channelId = userOwnedTempChannels.get(userId)
  if (!channelId) return null
  return guild.channels.cache.get(channelId) || null
}

function getVoiceControlChannel(member) {
  const channel = member.voice.channel
  if (!channel) return { error: '❌ You need to be inside your temp voice channel first.' }

  const ownerId = tempVoiceOwners.get(channel.id)
  if (!ownerId) return { error: '❌ This is not a managed VoiceMaster channel.' }

  if (ownerId !== member.id) {
    return { error: '❌ You only control the temp voice channel you own.' }
  }

  return { channel }
}

async function ensureVoiceMasterPanel() {
  try {
    const menuChannel = client.channels.cache.get(VOICEMASTER_MENU_CHANNEL)
      || await client.channels.fetch(VOICEMASTER_MENU_CHANNEL).catch(() => null)

    if (!menuChannel || !menuChannel.isTextBased()) {
      console.error('VoiceMaster menu channel missing or not text based.')
      return
    }

    const recent = await menuChannel.messages.fetch({ limit: 20 }).catch(() => null)
    const oldPanels = recent
      ? recent.filter(m => m.author.id === client.user.id && m.embeds.some(e => e.title === '🔊 VoiceMaster'))
      : null

    if (oldPanels && oldPanels.size) {
      for (const [, msg] of oldPanels) {
        await msg.delete().catch(() => {})
      }
    }

    await menuChannel.send({
      embeds: [buildVoiceMasterPanelEmbed()],
      components: buildVoiceMasterRows()
    })
  } catch (err) {
    console.error('Failed to set up VoiceMaster panel:', err?.message || err)
  }
}

async function createTempVoiceChannel(member) {
  try {
    const existing = getOwnedVoiceChannelForUser(member.id, member.guild)
    if (existing) {
      await member.voice.setChannel(existing).catch(() => {})
      return
    }

    const createChannel = member.guild.channels.cache.get(VOICEMASTER_CREATE_CHANNEL)
      || await member.guild.channels.fetch(VOICEMASTER_CREATE_CHANNEL).catch(() => null)

    if (!createChannel || createChannel.type !== ChannelType.GuildVoice) {
      console.error('VoiceMaster create channel missing or not a voice channel.')
      return
    }

    const safeName = member.user.username.replace(/[^\w\s'-]/g, '').trim() || member.user.username
    const channelName = `${safeName}'s room`

    const newChannel = await member.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: createChannel.parentId || null,
      bitrate: createChannel.bitrate || 64000,
      userLimit: 0,
      permissionOverwrites: [
        {
          id: member.guild.roles.everyone.id,
          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect
          ]
        },
        {
          id: VERIFIED_ROLE,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak
          ]
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.Stream,
            PermissionFlagsBits.UseVAD,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ]
    }).catch(err => {
      console.error('Failed to create temp voice channel:', err?.message || err)
      return null
    })

    if (!newChannel) return

    tempVoiceOwners.set(newChannel.id, member.id)
    userOwnedTempChannels.set(member.id, newChannel.id)

    await member.voice.setChannel(newChannel).catch(err => {
      console.error('Failed to move member into temp voice channel:', err?.message || err)
    })
  } catch (err) {
    console.error('createTempVoiceChannel error:', err?.message || err)
  }
}

async function cleanupTempVoiceChannel(channel) {
  try {
    if (!channel) return
    if (!tempVoiceOwners.has(channel.id)) return
    if (channel.members.size > 0) return

    const ownerId = tempVoiceOwners.get(channel.id)
    tempVoiceOwners.delete(channel.id)

    if (ownerId && userOwnedTempChannels.get(ownerId) === channel.id) {
      userOwnedTempChannels.delete(ownerId)
    }

    await channel.delete('VoiceMaster temp channel empty').catch(err => {
      console.error('Failed to delete temp voice channel:', err?.message || err)
    })
  } catch (err) {
    console.error('cleanupTempVoiceChannel error:', err?.message || err)
  }
}

async function rebuildModerationPanel() {
  const modChannel = client.channels.cache.get(MOD_CHANNEL)
    || await client.channels.fetch(MOD_CHANNEL).catch(() => null)

  if (!modChannel || !modChannel.isTextBased()) {
    throw new Error('mod channel not found')
  }

  const dashboardMessage = await modChannel.send({ content: 'Loading verification dashboard...' })
  queueMessageId = dashboardMessage.id

  const logMessage = await modChannel.send({
    embeds: [buildVerificationLogEmbed('none', 'approved', null, 'system')]
  })
  verificationLogMessageId = logMessage.id

  dashboardPage = 0
  await updateQueuePanel()
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`)

  try {
    const modChannel = await client.channels.fetch(MOD_CHANNEL)

    if (!modChannel || !modChannel.isTextBased()) {
      console.error('Mod channel is missing or not text based.')
      return
    }

    const recent = await modChannel.messages.fetch({ limit: 25 }).catch(() => null)

    const existingDashboard = recent
      ? recent.find(m => m.author.id === client.user.id && (m.embeds.some(e => e.title?.includes('Verification Queue')) || m.content === 'Loading verification dashboard...'))
      : null

    const existingLog = recent
      ? recent.find(m => m.author.id === client.user.id && m.embeds.some(e => e.title?.includes('Latest Verification Action')))
      : null

    if (existingDashboard) {
      queueMessageId = existingDashboard.id
      console.log('Recovered existing dashboard message.')
    } else {
      const msg = await modChannel.send({ content: 'Loading verification dashboard...' })
      queueMessageId = msg.id
      console.log('Created new dashboard message.')
    }

    if (existingLog) {
      verificationLogMessageId = existingLog.id
    }

    if (!dashboardStarted) {
      dashboardStarted = true
      setInterval(updateQueuePanel, REFRESH_INTERVAL)
    }

    await updateQueuePanel()
    console.log('Verification dashboard initialized.')
  } catch (err) {
    console.error(`Could not access mod channel (${MOD_CHANNEL}): ${err?.message || err}`)
  }
})

client.on('guildMemberAdd', async member => {
  await sendWelcomeEmbed(member)
})

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!newState.member || newState.member.user.bot) return

    if (newState.channelId === VOICEMASTER_CREATE_CHANNEL) {
      await createTempVoiceChannel(newState.member)
      return
    }

    if (oldState.channel && oldState.channel.id !== newState.channelId) {
      await cleanupTempVoiceChannel(oldState.channel)
    }
  } catch (err) {
    console.error('voiceStateUpdate error:', err?.message || err)
  }
})

client.on('messageCreate', async message => {
  if (message.author.bot) return
  if (processedMessages.has(message.id)) return

  rememberMessage(message.id)

  const content = message.content.trim()
  if (!content) return

  const args = content.split(/\s+/)
  const cmd = args[0].toLowerCase()

  if (cmd === '%help') {
    return await message.channel.send({
      embeds: [buildHelpHomeEmbed()],
      components: buildHelpComponents(message.guild?.id)
    })
  }

  if (cmd === '!setup') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_verify')
        .setLabel('Request Verification')
        .setStyle(ButtonStyle.Primary)
    )

    return await message.channel.send({
      embeds: [buildSetupEmbed()],
      components: [row]
    })
  }

  if (cmd === '!verify-refresh') {
    if (!hasStaffAccess(message.member)) {
      return await message.reply('❌ You do not have permission to use this command.')
    }

    await updateQueuePanel()
    return await message.reply('✅ Verification dashboard refreshed.')
  }

  if (cmd === '!mod-setup') {
    if (!hasStaffAccess(message.member)) {
      return await message.reply('❌ no permission.')
    }

    await rebuildModerationPanel()
    return await message.reply('✅ moderation system restored.')
  }

  if (cmd === '!ticket-setup') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('open_ticket')
        .setLabel('🎫 Open a Ticket')
        .setStyle(ButtonStyle.Primary)
    )

    return await message.channel.send({
      embeds: [buildTicketPanelEmbed()],
      components: [row]
    })
  }

  if (cmd === '!voicemaster-setup') {
    if (!hasStaffAccess(message.member)) {
      return await message.reply('❌ You do not have permission to use this command.')
    }

    await ensureVoiceMasterPanel()
    return await message.reply(`✅ VoiceMaster panel sent to <#${VOICEMASTER_MENU_CHANNEL}>.`)
  }

  if (cmd === '!testwelcome') {
    const member = message.member
    if (!hasStaffAccess(member)) {
      return await message.reply('❌ You do not have permission to use this command.')
    }

    const targetMember = message.mentions.members.first() || message.member
    await sendWelcomeEmbed(targetMember)

    return await message.reply(`✅ Sent a test welcome embed for **${targetMember.user.username}**.`)
  }

  if (cmd === '%stop') {
    endSession(message)
    return await message.reply('conversation ended. start again with `%talk` or by mentioning me.')
  }

  if (cmd === '%bal' || cmd === '%balance') {
    const target = message.mentions.users.first() || message.author
    const balance = eco.getBalance(target.id)

    return await message.channel.send({
      embeds: [buildBalanceEmbed(target, balance)]
    })
  }

  if (cmd === '%daily') {
    if (!eco.canClaimDaily(message.author.id)) {
      const left = eco.dailyCooldownLeft(message.author.id)
      return await message.reply(`⏳ You already claimed your daily. Come back in **${left}**.`)
    }

    const amount = eco.claimDaily(message.author.id)
    const balance = eco.getBalance(message.author.id)

    return await message.channel.send({
      embeds: [buildDailyEmbed(amount, balance)]
    })
  }

  if (cmd === '%work') {
    if (!eco.canWork(message.author.id)) {
      const left = eco.workCooldownLeft(message.author.id)
      return await message.reply(`⏳ You’re tired. Come back in **${left}**.`)
    }

    const amount = eco.doWork(message.author.id)
    const jobs = [
      'fixed some bugs',
      'drove a taxi',
      'delivered packages',
      'cooked meals',
      'taught a class',
      'sold lemonade',
      'walked some dogs'
    ]
    const job = jobs[Math.floor(Math.random() * jobs.length)]
    const balance = eco.getBalance(message.author.id)

    return await message.channel.send({
      embeds: [buildWorkEmbed(job, amount, balance)]
    })
  }

  if (cmd === '%pay') {
    const target = message.mentions.users.first()
    const amount = parseInt(args[2], 10)

    if (!target || target.bot) {
      return await message.reply('❌ Please mention a valid user.')
    }

    if (!amount || amount <= 0) {
      return await message.reply('❌ Please enter a valid amount.')
    }

    if (target.id === message.author.id) {
      return await message.reply('❌ You can’t pay yourself.')
    }

    if (eco.getBalance(message.author.id) < amount) {
      return await message.reply('❌ You don’t have enough coins.')
    }

    eco.removeBalance(message.author.id, amount)
    eco.addBalance(target.id, amount)

    return await message.channel.send({
      embeds: [buildPayEmbed(message.author, target, amount)]
    })
  }

  if (cmd === '%lb' || cmd === '%leaderboard') {
    const board = eco.getLeaderboard()

    const lines = await Promise.all(
      board.slice(0, 10).map(async ([uid, data], i) => {
        const medals = ['🥇', '🥈', '🥉']
        const medal = medals[i] || `**${i + 1}.**`

        let name = uid
        try {
          const u = await client.users.fetch(uid)
          name = u.username
        } catch {}

        return `${medal} **${name}** — ${data.balance.toLocaleString()} coins`
      })
    )

    return await message.channel.send({
      embeds: [buildLeaderboardEmbed(lines)]
    })
  }

  if (cmd === '%slots') {
    const amount = parseInt(args[1], 10)

    if (!amount || amount <= 0) {
      return await message.reply('❌ Enter a valid bet amount.')
    }

    if (eco.getBalance(message.author.id) < amount) {
      return await message.reply('❌ Not enough coins.')
    }

    const symbols = ['🍒', '🍋', '🍊', '⭐', '💎', '🎰']
    const spin = () => symbols[Math.floor(Math.random() * symbols.length)]
    const reels = [spin(), spin(), spin()]

    let winnings = 0
    let result = '💔 No luck this time.'

    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      if (reels[0] === '💎') {
        winnings = amount * 10
        result = '💎 JACKPOT! 10x'
      } else if (reels[0] === '⭐') {
        winnings = amount * 5
        result = '⭐ Big Win! 5x'
      } else {
        winnings = amount * 3
        result = '🎉 You win! 3x'
      }
    } else if (
      reels[0] === reels[1] ||
      reels[1] === reels[2] ||
      reels[0] === reels[2]
    ) {
      winnings = Math.floor(amount * 1.5)
      result = '👍 Small Win! 1.5x'
    }

    eco.removeBalance(message.author.id, amount)
    if (winnings > 0) eco.addBalance(message.author.id, winnings)

    const changeText = winnings > 0
      ? `+${(winnings - amount).toLocaleString()} coins`
      : `-${amount.toLocaleString()} coins`

    return await message.channel.send({
      embeds: [buildSlotsEmbed(reels, result, changeText, eco.getBalance(message.author.id), winnings > 0)]
    })
  }

  if (cmd === '%coinflip' || cmd === '%cf') {
    const choice = args[1]?.toLowerCase()
    const amount = parseInt(args[2], 10)

    if (!['heads', 'tails', 'h', 't'].includes(choice)) {
      return await message.reply('❌ Choose `heads` or `tails`.')
    }

    if (!amount || amount <= 0) {
      return await message.reply('❌ Enter a valid bet amount.')
    }

    if (eco.getBalance(message.author.id) < amount) {
      return await message.reply('❌ Not enough coins.')
    }

    const flip = Math.random() < 0.5 ? 'heads' : 'tails'
    const playerPick = choice.startsWith('h') ? 'heads' : 'tails'
    const won = flip === playerPick

    if (won) {
      eco.addBalance(message.author.id, amount)
    } else {
      eco.removeBalance(message.author.id, amount)
    }

    return await message.channel.send({
      embeds: [buildCoinflipEmbed(playerPick, flip, amount, eco.getBalance(message.author.id), won)]
    })
  }

  const trigger = shouldTriggerBotChat(message, cmd, content)

  if (trigger.should) {
    if (trigger.stop) {
      endSession(message)
      return await message.reply('conversation ended. start again with `%talk` or by mentioning me.')
    }

    const input = trigger.input?.trim()

    if (!input) {
      return await message.reply('say something.')
    }

    pushMemory(message.author.id, 'user', input)

    await message.channel.sendTyping()

    let reply = null

    try {
      reply = await buildGeminiReply(message.author.id, input)
      console.log('Gemini reply success for', message.author.tag)
    } catch (err) {
      console.error('Gemini chat error:', err?.message || err)
    }

    if (!reply) {
      return await message.reply('my brain is being weird rn, try again in a sec :3')
    }

    pushMemory(message.author.id, 'bot', reply)

    const sent = await message.reply(reply)
    touchSession(message, sent.id)
    return
  }
})

async function updateQueuePanel() {
  if (dashboardUpdating) return
  dashboardUpdating = true

  try {
    if (!queueMessageId) return

    const modChannel = client.channels.cache.get(MOD_CHANNEL)
      || await client.channels.fetch(MOD_CHANNEL).catch(() => null)

    if (!modChannel || !modChannel.isTextBased()) return

    const guild = client.guilds.cache.first()
    const pendingEntries = getPendingRequestsArray()
    const totalPending = pendingEntries.length

    clampDashboardPage()

    const pageCount = getDashboardPageCount()
    const start = dashboardPage * DASHBOARD_PAGE_SIZE
    const visible = pendingEntries.slice(start, start + DASHBOARD_PAGE_SIZE)

    for (const [userId, info] of visible) {
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null
      const nickname = member?.nickname || 'None'
      const createdAt = info.user.createdAt?.toDateString() || 'Unknown'
      const joinedAt = member?.joinedAt?.toDateString() || 'N/A'
      const roles = member
        ? member.roles.cache.map(r => r.name).filter(n => n !== '@everyone').join(', ') || 'None'
        : 'N/A'
      info.summaryText = `**Nickname:** ${nickname}\n**Created:** ${createdAt}\n**Joined:** ${joinedAt}\n**Roles:** ${roles}`
    }

    const embed = buildDashboardEmbed(visible, dashboardPage, pageCount, totalPending)
    const components = buildDashboardComponents(dashboardPage, pageCount, visible)

    const msg = await modChannel.messages.fetch(queueMessageId).catch(() => null)
    if (!msg) {
      console.error('Dashboard message not found, will recreate on next restart.')
      return
    }

    await msg.edit({ content: '', embeds: [embed], components })
  } catch (err) {
    console.error('Dashboard update failed:', err?.message || err)
  } finally {
    dashboardUpdating = false
  }
}

const processingRequests = new Set()

async function resolveRequest(userId, status, reason = null, moderatorTag = 'Unknown') {
  if (processingRequests.has(userId)) return
  processingRequests.add(userId)

  try {
    const guild = client.guilds.cache.first()
    const target = guild ? await guild.members.fetch(userId).catch(() => null) : null

    if (status === 'approved' && target) {
      await target.roles.add(VERIFIED_ROLE).catch(err => console.error(`Failed to add Verified role to ${userId}:`, err?.message))
      await target.roles.remove(UNVERIFIED_ROLE).catch(err => console.error(`Failed to remove Unverified role from ${userId}:`, err?.message))
      await target.send('✅ Your verification has been **approved**. Welcome to the server.').catch(() => {})
      console.log(`Approved verification for ${userId}`)
    }

    if (status === 'denied' && target) {
      const msg = reason
        ? `❌ Your verification was **denied**.\n**Reason:** ${reason}\n\nYou may re-request at any time.`
        : `❌ Your verification was **denied**.\n\nYou may re-request at any time.`
      await target.send(msg).catch(() => {})
      console.log(`Denied verification for ${userId}${reason ? ` (reason: ${reason})` : ''}`)
    }

    if (requests.has(userId)) {
      requests.set(userId, { ...requests.get(userId), status })
    }

    await updateQueuePanel()
    await postVerificationActionLog(userId, status, moderatorTag, reason)

    setTimeout(async () => {
      requests.delete(userId)
      processingRequests.delete(userId)
      clampDashboardPage()
      await updateQueuePanel()
    }, 5000)
  } catch (err) {
    console.error(`resolveRequest error for ${userId}:`, err?.message || err)
    processingRequests.delete(userId)
  }
}

client.on('interactionCreate', async interaction => {
  if (interaction.isStringSelectMenu() && interaction.customId === 'help_category_select') {
    const value = interaction.values[0]
    return await interaction.update({
      embeds: [buildHelpCategoryEmbed(value)],
      components: buildHelpComponents(interaction.guildId)
    })
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    if (interaction.customId.startsWith('deny_modal_')) {
      const userId = interaction.customId.split('_')[2]

      if (!requests.has(userId)) {
        return await interaction.reply({
          content: 'This request has already been processed.',
          ephemeral: true
        })
      }

      await interaction.deferReply({ ephemeral: true })
      const reason = interaction.fields.getTextInputValue('deny_reason')
      await resolveRequest(userId, 'denied', reason, interaction.user.tag)

      return await interaction.editReply({
        content: `❌ Denied <@${userId}>${reason ? ` — reason: ${reason}` : ''}`
      })
    }

    if (interaction.customId === 'vm_rename_modal') {
      const member = interaction.guild.members.cache.get(interaction.user.id)
      const result = getVoiceControlChannel(member)

      if (result.error) {
        return await interaction.reply({ content: result.error, ephemeral: true })
      }

      const newName = interaction.fields.getTextInputValue('vm_rename_input').trim().slice(0, 100)
      if (!newName) {
        return await interaction.reply({ content: '❌ Give the channel a real name.', ephemeral: true })
      }

      await result.channel.setName(newName).catch(err => {
        console.error('Voice rename error:', err?.message || err)
      })

      return await interaction.reply({
        content: `✅ Renamed your channel to **${newName}**.`,
        ephemeral: true
      })
    }

    if (interaction.customId === 'vm_limit_modal') {
      const member = interaction.guild.members.cache.get(interaction.user.id)
      const result = getVoiceControlChannel(member)

      if (result.error) {
        return await interaction.reply({ content: result.error, ephemeral: true })
      }

      const raw = interaction.fields.getTextInputValue('vm_limit_input').trim()
      const limit = parseInt(raw, 10)

      if (Number.isNaN(limit) || limit < 0 || limit > 99) {
        return await interaction.reply({
          content: '❌ Enter a number from 0 to 99.',
          ephemeral: true
        })
      }

      await result.channel.setUserLimit(limit).catch(err => {
        console.error('Voice limit error:', err?.message || err)
      })

      return await interaction.reply({
        content: `✅ User limit set to **${limit}**.`,
        ephemeral: true
      })
    }

    return
  }

  if (!interaction.isButton()) return

  if (interaction.customId === 'verify_prev') {
    if (!hasStaffAccess(interaction.member)) {
      return await interaction.reply({
        content: '❌ You do not have permission to do that.',
        ephemeral: true
      })
    }

    dashboardPage -= 1
    clampDashboardPage()
    await updateQueuePanel()

    return await interaction.reply({
      content: `✅ moved to page ${dashboardPage + 1}.`,
      ephemeral: true
    })
  }

  if (interaction.customId === 'verify_next') {
    if (!hasStaffAccess(interaction.member)) {
      return await interaction.reply({
        content: '❌ You do not have permission to do that.',
        ephemeral: true
      })
    }

    dashboardPage += 1
    clampDashboardPage()
    await updateQueuePanel()

    return await interaction.reply({
      content: `✅ moved to page ${dashboardPage + 1}.`,
      ephemeral: true
    })
  }

  if (interaction.customId === 'verify_refresh') {
    if (!hasStaffAccess(interaction.member)) {
      return await interaction.reply({
        content: '❌ You do not have permission to do that.',
        ephemeral: true
      })
    }

    await updateQueuePanel()
    return await interaction.reply({
      content: '✅ Verification dashboard refreshed.',
      ephemeral: true
    })
  }

  if (interaction.customId === 'start_verify') {
    if (!interaction.user.avatar) {
      return await interaction.reply({
        content: '❌ You need a custom profile picture before you can verify.',
        ephemeral: true
      })
    }

    if (requests.has(interaction.user.id) && requests.get(interaction.user.id).status === 'pending') {
      return await interaction.reply({
        content: '⏳ You already have a verification request in progress. Please wait for staff to review it.',
        ephemeral: true
      })
    }

    await interaction.deferReply({ ephemeral: true })

    requests.set(interaction.user.id, {
      user: interaction.user,
      timestamp: Date.now(),
      status: 'pending'
    })

    clampDashboardPage()
    await updateQueuePanel()
    await interaction.user.send('📋 Your verification request has been received. Staff will review it shortly.').catch(() => {})

    return await interaction.editReply({
      content: '✅ Your request has been sent to staff. You will be notified by DM once it is reviewed.'
    })
  }

  if (interaction.customId.startsWith('view_')) {
    const userId = interaction.customId.split('_')[1]

    if (!requests.has(userId)) {
      return await interaction.reply({
        content: 'This request has already been processed.',
        ephemeral: true
      })
    }

    await interaction.deferReply({ ephemeral: true })

    const info = requests.get(userId)
    const member = interaction.guild ? await interaction.guild.members.fetch(userId).catch(() => null) : null

    const nickname = member?.nickname || 'None'
    const createdAt = info.user.createdAt?.toDateString() || 'Unknown'
    const joinedAt = member?.joinedAt?.toDateString() || 'N/A'
    const roles = member
      ? member.roles.cache.map(r => r.name).filter(name => name !== '@everyone').join(', ') || 'None'
      : 'None'

    const avatarUrl = info.user.displayAvatarURL({ dynamic: true, size: 256 })

    return await interaction.editReply({
      embeds: [buildUserInfoEmbed(info.user, nickname, createdAt, joinedAt, roles, avatarUrl)]
    })
  }

  if (interaction.customId.startsWith('approve_')) {
    const userId = interaction.customId.split('_')[1]

    if (!requests.has(userId) || requests.get(userId).status !== 'pending') {
      return await interaction.reply({
        content: 'This request has already been processed.',
        ephemeral: true
      })
    }

    if (processingRequests.has(userId)) {
      return await interaction.reply({
        content: '⏳ Already processing this request, please wait.',
        ephemeral: true
      })
    }

    await interaction.deferReply({ ephemeral: true })
    await resolveRequest(userId, 'approved', null, interaction.user.tag)

    return await interaction.editReply({
      content: `✅ <@${userId}> has been approved and given the Verified role.`
    })
  }

  if (interaction.customId.startsWith('deny_')) {
    const userId = interaction.customId.split('_')[1]

    if (!requests.has(userId) || requests.get(userId).status !== 'pending') {
      return await interaction.reply({
        content: 'This request has already been processed.',
        ephemeral: true
      })
    }

    const modal = new ModalBuilder()
      .setCustomId(`deny_modal_${userId}`)
      .setTitle('Enter Denial Reason')

    const input = new TextInputBuilder()
      .setCustomId('deny_reason')
      .setLabel('Reason for denial')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)

    modal.addComponents(new ActionRowBuilder().addComponents(input))

    return await interaction.showModal(modal)
  }

  if (interaction.customId === 'open_ticket') {
    const { guild, user } = interaction

    if (openTickets.has(user.id)) {
      const existing = guild.channels.cache.get(openTickets.get(user.id))
      if (existing) {
        return await interaction.reply({
          content: `You already have an open ticket: ${existing}`,
          ephemeral: true
        })
      }
      openTickets.delete(user.id)
    }

    const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')
    const channelName = `ticket-${safeName}`

    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      }
    ]

    if (STAFF_ROLE) {
      permissionOverwrites.push({
        id: STAFF_ROLE,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
      })
    }

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY || null,
      permissionOverwrites,
      topic: `Ticket opened by ${user.tag} — ${new Date().toUTCString()}`
    }).catch(err => {
      console.error('Failed to create ticket channel:', err?.message || err)
      return null
    })

    if (!ticketChannel) {
      return await interaction.reply({
        content: '❌ Failed to create ticket channel. Make sure the bot has Manage Channels permission.',
        ephemeral: true
      })
    }

    openTickets.set(user.id, ticketChannel.id)

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`close_ticket_${user.id}`)
        .setLabel('🔒 Close Ticket')
        .setStyle(ButtonStyle.Danger)
    )

    await ticketChannel.send({
      embeds: [buildTicketWelcomeEmbed(user)],
      components: [closeRow]
    })

    return await interaction.reply({
      content: `✅ Your ticket has been opened: ${ticketChannel}`,
      ephemeral: true
    })
  }

  if (interaction.customId.startsWith('close_ticket_')) {
    const ticketOwnerId = interaction.customId.split('_')[2]
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const isStaff = hasStaffAccess(member)

    if (interaction.user.id !== ticketOwnerId && !isStaff) {
      return await interaction.reply({
        content: '❌ Only the ticket owner or staff can close this ticket.',
        ephemeral: true
      })
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_close_${interaction.channel.id}_${ticketOwnerId}`)
        .setLabel('✅ Confirm Close')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel_close')
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Secondary)
    )

    return await interaction.reply({
      embeds: [buildTicketCloseConfirmEmbed()],
      components: [confirmRow],
      ephemeral: true
    })
  }

  if (interaction.customId.startsWith('confirm_close_')) {
    const parts = interaction.customId.split('_')
    const channelId = parts[2]
    const ticketOwnerId = parts[3]

    openTickets.delete(ticketOwnerId)

    const channel = interaction.guild.channels.cache.get(channelId)

    if (!channel) {
      return await interaction.reply({
        content: '❌ Channel not found.',
        ephemeral: true
      })
    }

    await interaction.reply({ content: '🔒 Closing ticket...', ephemeral: true }).catch(() => {})

    setTimeout(() => {
      channel.delete('Ticket closed').catch(err => {
        console.error('Failed to delete ticket channel:', err?.message || err)
      })
    }, 1500)

    return
  }

  if (interaction.customId === 'cancel_close') {
    return await interaction.reply({
      content: '✅ Close cancelled.',
      ephemeral: true
    })
  }

  if (interaction.customId === 'vm_rename') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const result = getVoiceControlChannel(member)

    if (result.error) {
      return await interaction.reply({ content: result.error, ephemeral: true })
    }

    const modal = new ModalBuilder()
      .setCustomId('vm_rename_modal')
      .setTitle('Rename Voice Channel')

    const input = new TextInputBuilder()
      .setCustomId('vm_rename_input')
      .setLabel('New channel name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100)

    modal.addComponents(new ActionRowBuilder().addComponents(input))
    return await interaction.showModal(modal)
  }

  if (interaction.customId === 'vm_limit') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const result = getVoiceControlChannel(member)

    if (result.error) {
      return await interaction.reply({ content: result.error, ephemeral: true })
    }

    const modal = new ModalBuilder()
      .setCustomId('vm_limit_modal')
      .setTitle('Set Voice Limit')

    const input = new TextInputBuilder()
      .setCustomId('vm_limit_input')
      .setLabel('Enter a number from 0 to 99')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(2)

    modal.addComponents(new ActionRowBuilder().addComponents(input))
    return await interaction.showModal(modal)
  }

  if (interaction.customId === 'vm_lock') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const result = getVoiceControlChannel(member)

    if (result.error) {
      return await interaction.reply({ content: result.error, ephemeral: true })
    }

    await result.channel.permissionOverwrites.edit(VERIFIED_ROLE, {
      Connect: false
    }).catch(err => console.error('vm lock error:', err?.message || err))

    return await interaction.reply({
      content: '✅ Your voice channel is now locked.',
      ephemeral: true
    })
  }

  if (interaction.customId === 'vm_unlock') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const result = getVoiceControlChannel(member)

    if (result.error) {
      return await interaction.reply({ content: result.error, ephemeral: true })
    }

    await result.channel.permissionOverwrites.edit(VERIFIED_ROLE, {
      Connect: true
    }).catch(err => console.error('vm unlock error:', err?.message || err))

    return await interaction.reply({
      content: '✅ Your voice channel is now unlocked.',
      ephemeral: true
    })
  }

  if (interaction.customId === 'vm_hide') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const result = getVoiceControlChannel(member)

    if (result.error) {
      return await interaction.reply({ content: result.error, ephemeral: true })
    }

    await result.channel.permissionOverwrites.edit(VERIFIED_ROLE, {
      ViewChannel: false
    }).catch(err => console.error('vm hide error:', err?.message || err))

    return await interaction.reply({
      content: '✅ Your voice channel is now hidden.',
      ephemeral: true
    })
  }

  if (interaction.customId === 'vm_show') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const result = getVoiceControlChannel(member)

    if (result.error) {
      return await interaction.reply({ content: result.error, ephemeral: true })
    }

    await result.channel.permissionOverwrites.edit(VERIFIED_ROLE, {
      ViewChannel: true
    }).catch(err => console.error('vm show error:', err?.message || err))

    return await interaction.reply({
      content: '✅ Your voice channel is visible again.',
      ephemeral: true
    })
  }

  if (interaction.customId === 'vm_claim') {
    const member = interaction.guild.members.cache.get(interaction.user.id)
    const channel = member.voice.channel

    if (!channel) {
      return await interaction.reply({
        content: '❌ Join a temp voice channel first.',
        ephemeral: true
      })
    }

    const ownerId = tempVoiceOwners.get(channel.id)
    if (!ownerId) {
      return await interaction.reply({
        content: '❌ This is not a managed VoiceMaster channel.',
        ephemeral: true
      })
    }

    if (ownerId === interaction.user.id) {
      return await interaction.reply({
        content: '❌ You already own this voice channel.',
        ephemeral: true
      })
    }

    const oldOwnerStillHere = channel.members.has(ownerId)
    if (oldOwnerStillHere) {
      return await interaction.reply({
        content: '❌ You can only claim a channel if the owner has left.',
        ephemeral: true
      })
    }

    const oldOwned = userOwnedTempChannels.get(ownerId)
    if (oldOwned === channel.id) {
      userOwnedTempChannels.delete(ownerId)
    }

    tempVoiceOwners.set(channel.id, interaction.user.id)
    userOwnedTempChannels.set(interaction.user.id, channel.id)

    await channel.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: true,
      Connect: true,
      Speak: true,
      Stream: true,
      UseVAD: true,
      MoveMembers: true,
      MuteMembers: true,
      DeafenMembers: true,
      ManageChannels: true
    }).catch(err => console.error('vm claim error:', err?.message || err))

    return await interaction.reply({
      content: '✅ You now own this voice channel.',
      ephemeral: true
    })
  }
})

client.login(TOKEN)
