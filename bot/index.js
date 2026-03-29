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
  PermissionFlagsBits
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
const MOD_CHANNEL = '1474932410763186309'
const STAFF_ROLE = '1474213205378339020'
const TICKET_CATEGORY = '1474929234664231073'
const TICKET_PANEL_CHANNEL = '1487956293736988753'

const REFRESH_INTERVAL = 10000
const MESSAGE_CACHE_TTL = 15000
const CHAT_SESSION_MS = 15 * 60 * 1000
const MAX_MEMORY = 16

const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null

const requests = new Map()
const processedMessages = new Set()
const memoryStore = new Map()
const chatSessions = new Map()
const openTickets = new Map()

let queueMessageId = null
let dashboardStarted = false
let dashboardUpdating = false

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
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
})

function rememberMessage(messageId) {
  processedMessages.add(messageId)
  setTimeout(() => processedMessages.delete(messageId), MESSAGE_CACHE_TTL)
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function containsAny(text, words) {
  return words.some(word => text.includes(word))
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

function getPreviousUserMessage(userId, current) {
  const memory = getMemory(userId)
  const userMessages = memory.filter(x => x.role === 'user').map(x => x.content)
  if (userMessages.length <= 1) return null
  for (let i = userMessages.length - 2; i >= 0; i--) {
    if (userMessages[i] !== current) return userMessages[i]
  }
  return null
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

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(0x00FFFF)
    .setTitle('⚡ Limb Bot Command Panel')
    .setDescription('Everything you need is right here.')
    .addFields(
      {
        name: '💬 Bot Chat',
        value: [
          '`%talk <message>` starts a conversation',
          '`@BotName <message>` also starts one',
          'After that, keep talking normally for 15 minutes',
          'Reply to the bot any time to continue',
          '`%stop` ends the conversation'
        ].join('\n'),
        inline: false
      },
      {
        name: '💰 Economy',
        value: [
          '`%bal [@user]`',
          '`%daily`',
          '`%work`',
          '`%pay @user <amount>`',
          '`%lb`',
          '`%slots <amount>`',
          '`%coinflip <heads/tails> <amount>`'
        ].join('\n'),
        inline: false
      },
      {
        name: '🛡️ Verification',
        value: [
          '`!setup` posts the verification panel',
          'Staff review requests from the dashboard',
          'Approve, deny, or inspect users from one place'
        ].join('\n'),
        inline: false
      },
      {
        name: '🎫 Tickets',
        value: [
          '`!ticket-setup` posts the ticket panel (staff)',
          'Click **Open a Ticket** to create a private support channel',
          'Click **🔒 Close Ticket** inside to close it'
        ].join('\n'),
        inline: false
      },
      {
        name: '📌 Help',
        value: '`%help` shows this panel',
        inline: false
      }
    )
    .setFooter({ text: 'Limb Bot • Command Center' })
    .setTimestamp()
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

function buildDashboardEmbed(sortedRequests) {
  const pendingCount = sortedRequests.filter(([, info]) => info.status === 'pending').length

  const embed = new EmbedBuilder()
    .setColor(0x00FFFF)
    .setTitle('🛡️ Verification Dashboard')
    .setDescription(`Total pending requests: **${pendingCount}**`)
    .setFooter({ text: 'Limb Bot • Staff Dashboard' })
    .setTimestamp()

  if (sortedRequests.length === 0) {
    embed.addFields({
      name: 'Queue',
      value: 'No pending verification requests.'
    })
    return embed
  }

  for (let position = 0; position < sortedRequests.length; position++) {
    const [, info] = sortedRequests[position]
    const emoji = getStatusEmoji(info.status, position)

    embed.addFields({
      name: `${emoji} #${position + 1} ${info.user.username}`,
      value: info.summaryText || 'Loading user details...',
      inline: false
    })
  }

  return embed
}

function buildTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎫 Open a Support Ticket')
    .setDescription(
      '> **Please only open a ticket if you genuinely need help.**\n\n' +
      'This is not a place for casual conversation — tickets are for real issues only.\n\n' +
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
      'A staff member will be with you shortly — please be patient.\n\n' +
      '**While you wait:**\n' +
      '• Describe your issue clearly in one message\n' +
      '• Include any relevant details or screenshots\n' +
      '• Do not ping staff — they will see this\n\n' +
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

function buildFallbackReply(userId, input) {
  const text = input.toLowerCase().trim()
  const previousUser = getPreviousUserMessage(userId, input)

  if (containsAny(text, ['hello', 'hi', 'hey', 'yo', 'sup'])) {
    return randomPick([
      'hey, what’s going on with you',
      'hey you, what’s up',
      'hi, talk to me',
      'yo, what’s on your mind'
    ])
  }

  if (containsAny(text, ['how are you', 'howre you', 'how r you'])) {
    return randomPick([
      'i’m good honestly, how are you doing',
      'doing alright, what about you',
      'pretty good rn, what’s your mood like today'
    ])
  }

  if (containsAny(text, ['sad', 'hurt', 'upset', 'crying', 'heartbroken', 'broken'])) {
    return randomPick([
      'i’m here, tell me what happened',
      'that sounds heavy, talk to me',
      'you don’t have to hold that in alone, start from the part that hurts most',
      'slow down and tell me what hit you the hardest'
    ])
  }

  if (containsAny(text, ['love', 'miss', 'relationship', 'girlfriend', 'boyfriend', 'crush', 'partner'])) {
    return randomPick([
      'that sounds personal, what part of it is hitting you the hardest',
      'relationships get messy fast, what happened',
      'talk to me, is this about missing someone, trusting someone, or losing someone'
    ])
  }

  if (containsAny(text, ['angry', 'mad', 'pissed', 'annoyed'])) {
    return randomPick([
      'what set you off',
      'tell me exactly what happened',
      'alright, get it out, what pushed you there'
    ])
  }

  if (containsAny(text, ['thank you', 'thanks', 'thx'])) {
    return randomPick([
      'you’re welcome',
      'any time',
      'no problem, i got you'
    ])
  }

  if (containsAny(text, ['bye', 'goodbye', 'cya', 'see you'])) {
    return randomPick([
      'alright, catch you later',
      'see you around',
      'later, take care'
    ])
  }

  if (text.includes('?')) {
    return randomPick([
      'good question, what’s your take first',
      'what answer are you hoping for',
      'there’s more behind that question, what are you really asking'
    ])
  }

  if (previousUser) {
    return randomPick([
      `you mentioned "${previousUser}" earlier, is this connected to that`,
      `this sounds close to what you said about "${previousUser}", same situation`,
      `i’m noticing a pattern with "${previousUser}", want to keep going on that`
    ])
  }

  return randomPick([
    'tell me more',
    'go a little deeper',
    'i’m listening',
    'be specific with me',
    'what happened next',
    'why does that matter to you',
    'break that down for me',
    'keep going'
  ])
}

async function buildGeminiReply(userId, input) {
  if (!gemini) return null

  const memory = getMemory(userId)
  const historyText = memory
    .map(entry => `${entry.role === 'user' ? 'User' : 'Bot'}: ${entry.content}`)
    .join('\n')

  const prompt = [
    'You are Limb Bot in a Discord server.',
    'Your vibe is cute, friendly, playful, a little teasing, emotionally aware, and natural.',
    'Type like a real online person.',
    'Use lowercase most of the time.',
    'Do not sound robotic.',
    'Keep most replies between 1 and 4 sentences unless the user asks for more.',
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

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`)

  try {
    const modChannel = await client.channels.fetch(MOD_CHANNEL)

    if (!modChannel || !modChannel.isTextBased()) {
      console.error('Mod channel is missing or not text based.')
      return
    }

    const recent = await modChannel.messages.fetch({ limit: 20 }).catch(() => null)
    const existing = recent
      ? recent.find(m => m.author.id === client.user.id && (m.embeds.some(e => e.title?.includes('Verification Dashboard')) || m.content === 'Loading verification dashboard...'))
      : null

    if (existing) {
      queueMessageId = existing.id
      console.log('Recovered existing dashboard message.')
    } else {
      const msg = await modChannel.send({ content: 'Loading verification dashboard...' })
      queueMessageId = msg.id
      console.log('Created new dashboard message.')
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

client.on('messageCreate', async message => {
  if (message.author.bot) return
  if (processedMessages.has(message.id)) return

  rememberMessage(message.id)

  const content = message.content.trim()
  if (!content) return

  const args = content.split(/\s+/)
  const cmd = args[0].toLowerCase()

  if (cmd === '%help') {
    return await message.channel.send({ embeds: [buildHelpEmbed()] })
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
      reply = buildFallbackReply(message.author.id, input)
      console.log('Using fallback reply for', message.author.tag)
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
    const visible = Array.from(requests.entries()).slice(0, 5)

    for (const [userId, info] of visible) {
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null
      const nickname = member?.nickname || 'None'
      const createdAt = info.user.createdAt?.toDateString() || 'Unknown'
      const joinedAt = member?.joinedAt?.toDateString() || 'N/A'
      const roles = member
        ? member.roles.cache.map(r => r.name).filter(n => n !== '@everyone').join(', ') || 'None'
        : 'N/A'
      info.summaryText = `**Nickname:** ${nickname}\n**Created:** ${createdAt}\n**Joined:** ${joinedAt}\n**Roles:** ${roles}\n**Status:** ${info.status}`
    }

    const embed = buildDashboardEmbed(visible)
    const components = []

    for (const [userId, info] of visible) {
      if (info.status === 'pending') {
        components.push(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`view_${userId}`)
              .setLabel('👁 View Info')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`approve_${userId}`)
              .setLabel('✅ Approve')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`deny_${userId}`)
              .setLabel('❌ Deny')
              .setStyle(ButtonStyle.Danger)
          )
        )
      }
    }

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

async function resolveRequest(userId, status, reason = null) {
  if (processingRequests.has(userId)) return
  processingRequests.add(userId)

  try {
    const guild = client.guilds.cache.first()
    const target = guild ? await guild.members.fetch(userId).catch(() => null) : null

    if (status === 'approved' && target) {
      await target.roles.add(VERIFIED_ROLE).catch(err => console.error(`Failed to add Verified role to ${userId}:`, err?.message))
      await target.roles.remove(UNVERIFIED_ROLE).catch(err => console.error(`Failed to remove Unverified role from ${userId}:`, err?.message))
      await target.send('✅ Your verification has been **approved**. Welcome to the server — you now have the Verified role.').catch(() => {})
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

    setTimeout(async () => {
      requests.delete(userId)
      processingRequests.delete(userId)
      await updateQueuePanel()
    }, 5000)
  } catch (err) {
    console.error(`resolveRequest error for ${userId}:`, err?.message || err)
    processingRequests.delete(userId)
  }
}

client.on('interactionCreate', async interaction => {
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
      await resolveRequest(userId, 'denied', reason)

      return await interaction.editReply({
        content: `❌ Denied <@${userId}>${reason ? ` — reason: ${reason}` : ''}`
      })
    }

    return
  }

  if (!interaction.isButton()) return

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

    await interaction.deferReply({ ephemeral: false })
    await resolveRequest(userId, 'approved')

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
    const isStaff = STAFF_ROLE
      ? member?.roles.cache.has(STAFF_ROLE)
      : member?.permissions.has(PermissionFlagsBits.ManageChannels)

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
  }

  if (interaction.customId === 'cancel_close') {
    return await interaction.reply({
      content: '✅ Close cancelled.',
      ephemeral: true
    })
  }
})

client.login(TOKEN)
