const { WebClient } = require('@slack/web-api')
const { RTMClient } = require('@slack/rtm-api')

let Redis
try {
  Redis = require('ioredis')
} catch (e) {
}

const defaultWarningMessage = 'Do not use either <!here> or <!channel> here.'

class MemorySettingRepository {
  constructor() {
    this.store = {}
  }

  _getStore(channel) {
    if (!this.store.hasOwnProperty(channel)) {
      this.store[channel] = {}
    }
    return this.store[channel]
  }

  async getMessage(channel) {
    const store = this._getStore(channel)
    return store.hasOwnProperty('message') ? store.message : defaultWarningMessage
  }

  async setMessage(channel, message) {
    this._getStore(channel)['message'] = message
  }

  async getMembers(channel) {
    const store = this._getStore(channel)
    if (!store.hasOwnProperty('members')) {
      store['members'] = []
    }
    return store['members']
  }

  async grantMember(channel, member) {
    this.revokeMember(channel, member)
    const store = this._getStore(channel)
    store['members'].push(member)
  }

  async revokeMember(channel, member) {
    const store = this._getStore(channel)
    store['members'] = (store['members'] || []).filter(m => m !== member)
  }

  async revokeAll(channel) {
    const store = this._getStore(channel)
    store['members'] = []
  }

  async getPublicMode(channel) {
    const store = this._getStore(channel)
    return store.hasOwnProperty('public') ? store.public : false
  }

  async setPublicMode(channel, mode) {
    const store = this._getStore(channel)
    this._getStore(channel)['public'] = mode
  }
}

class RedisSettingRepository {
  constructor(redis) {
    this.redis = redis
  }

  async getMessage(channel) {
    return this.redis.get(`${channel}:msg`)
      .then(message => {
        return message !== null && message !== undefined ? message : defaultWarningMessage
      })
  }

  async setMessage(channel, message) {
    this.redis.set(`${channel}:msg`, message)
  }

  async getMembers(channel) {
    return this.redis.smembers(`${channel}:members`)
      .then(members => {
        return members !== null && members !== undefined ? members : []
      })
  }

  async grantMember(channel, member) {
    this.redis.sadd(`${channel}:members`, member)
  }

  async revokeMember(channel, member) {
    this.redis.srem(`${channel}:members`, member)
  }

  async revokeAll(channel) {
    this.redis.del(`${channel}:members`)
  }

  async getPublicMode(channel) {
    return this.redis.get(`${channel}:public`)
      .then(mode => {
        return mode !== null && mode !== undefined ? mode === 'true' : false
      })
  }

  async setPublicMode(channel, mode) {
    this.redis.set(`${channel}:public`, mode)
  }
}

class NoHereBotMessageHandler {
  constructor(repository, postMessage, channel, sender, botUserId) {
    this.repository = repository
    this.postMessage = postMessage
    this.channel = channel
    this.sender = sender
    this.botUserId = botUserId
  }

  isChannelValid() {
    return this.channel.match(/^[CG]/) !== null
  }

  async isSenderAllowedAtHere() {
    const allowedMembers = await this.repository.getMembers(this.channel)
    return allowedMembers.find(member => member === this.sender) !== undefined
  }

  async handle(text) {
    const botUserIdMention = `<@${this.botUserId}>`

    if (!this.isChannelValid()) {
      this.usage(false)
      return
    }

    if (text === undefined) {
      return
    }

    if (text.match(new RegExp(String.raw`(?:^\s*${botUserIdMention}|${botUserIdMention}\s*$)`)) !== null) {
      const command = text
        .replace(/(?:^\s+|\s+$)/g, '')
        .replace(new RegExp(String.raw`(?:^${botUserIdMention}\s*|\s*${botUserIdMention}$)`, 'g'), '')

      if (command === '') {
        this.postMessage({
          text: 'Invalid command'
        })

        this.usage(true)
        return
      }

      this.handleCommand(command)
      return
    }

    if (text.match(/<!(?:here|channel)>/) !== null) {
      if (!await this.isSenderAllowedAtHere()) {
        const isPublic = await this.repository.getPublicMode(this.channel)

        return this.postMessage({
          text: await this.repository.getMessage(this.channel),
          private: !isPublic
        })
      }
      return
    }
  }

  async handleCommand(command) {
    let matches

    if (command.match(/^(?:help|usage)\b/) !== null) {
      return this.usage(false)
    }

    if ((matches = command.match(/^message\s+([\s\S]+)$/)) !== null) {
      const message = matches[1].replace(/^(["'])([\s\S]*)\1$/, '$2')
      return this.handleSetMessageCommand(message)
    }

    if (command.match(/^message$/) !== null) {
      return this.handleGetMessageCommand()
    }

    const memberRegex = '<@[UW][0-9A-Z]+>'
    const membersRegex = String.raw`${memberRegex}(?:\s*,?\s*${memberRegex})*`

    if ((matches = command.match(new RegExp(String.raw`(?:grant|permit|allow|approve)\s+(${membersRegex})$`))) !== null) {
      matches = matches[1].match(new RegExp(memberRegex, 'g'))
        .map(src => src.substring(2, src.length - 1))   // trim beginning '<@' and trailing '>'
      return this.handleGrantCommand(matches)
    }

    if (command.match(new RegExp(String.raw`(?:revoke|forbit|disallow|refuse)\s+all\b`)) !== null) {
      return this.handleRevokeAllCommand()
    }

    if ((matches = command.match(new RegExp(String.raw`(?:revoke|forbit|disallow|refuse)\s+(${membersRegex})$`))) !== null) {
      matches = matches[1].match(new RegExp(memberRegex, 'g'))
        .map(src => src.substring(2, src.length - 1))   // trim beginning '<@' and trailing '>'
      return this.handleRevokeCommand(matches)
    }

    if (command.match(/^(?:granted|permitted|allowed|approved)$/) !== null) {
      return this.handleGrantedCommand()
    }

    if ((matches = command.match(/^public\s+(on|off|true|false)$/)) !== null) {
      const mode = matches[1] === 'on' || matches[1] === 'true'
      return this.handleSetPublicModeCommand(mode)
    }

    if ((matches = command.match(/^public\s*$/)) !== null) {
      return this.handleGetPublicModeCommand()
    }

    if ((matches = command.match(/^test\s*$/)) !== null) {
      return this.handleTestCommand()
    }

    this.postMessage({
      text: 'Invalid command'
    })
    this.usage(true)
  }

  async handleSetMessageCommand(message) {
    await this.repository.setMessage(this.channel, message)

    return this.postMessage({
      text: `Warning message was set as "${message}"`,
      private: true
    })
  }

  async handleGetMessageCommand() {
    return this.postMessage({
      text: `Warning message is "${await this.repository.getMessage(this.channel)}"`,
      private: true
    })
  }

  async handleGrantCommand(targetUsers) {
    // sequential synchronized process intentionally
    for (let member of targetUsers) {
      await this.repository.grantMember(this.channel, member)
    }

    const grantedUsers = targetUsers.map(member => `<@${member}>`)

    return this.postMessage({
      text: `Following users were granted: ${grantedUsers.join(' ')}`,
      private: true
    })
  }

  async handleRevokeCommand(targetUsers) {
    // sequential synchronized process intentionally
    for (let member of targetUsers) {
      await this.repository.revokeMember(this.channel, member)
    }

    const revokedUsers = targetUsers.map(member => `<@${member}>`)

    return this.postMessage({
      text: `Following users were revoked: ${revokedUsers.join(' ')}`,
      private: true
    })
  }

  async handleRevokeAllCommand(targetUsers) {
    await this.repository.revokeAll(this.channel)

    return this.postMessage({
      text: `All users were revoked`,
      private: true
    })
  }

  async handleGrantedCommand() {
    const grantedUsers = (await this.repository.getMembers(this.channel)).map(member => `<@${member}>`)

    if (grantedUsers.length === 0) {
      return this.postMessage({
        text: 'No user granted',
        private: true
      })
    } else {
      return this.postMessage({
        text: `Following users are granted: ${grantedUsers.join(' ')}`,
        private: true
      })
    }
  }

  async handleGetPublicModeCommand() {
    const mode = await this.repository.getPublicMode(this.channel)

    return this.postMessage({
      text: `Public mode is "${mode}"`,
      private: false
    })
  }

  async handleSetPublicModeCommand(mode) {
    await this.repository.setPublicMode(this.channel, mode)

    return this.postMessage({
      text: `Public mode was set as "${mode}"`,
      private: false
    })
  }

  async handleTestCommand(mode) {
    const isPublic = await this.repository.getPublicMode(this.channel)

    return this.postMessage({
      text: await this.repository.getMessage(this.channel),
      private: !isPublic
    })
  }

  async usage(isPrivate = false) {
    const botUserIdMention = `<@${this.botUserId}>`

    const helpMessage = `
      |${botUserIdMention}: bot which warns when somebody uses \`@​here\` / \`@​channel\`
      |
      |usage
      |  ${botUserIdMention} message <message>
      |    Set warning message
      |  ${botUserIdMention} message ""
      |    Reset warning message
      |  ${botUserIdMention} message
      |    Show warning message
      |  ${botUserIdMention} grant \`@​user\` [\`@​others\` ...]
      |    Grant user to use \`@​here\` / \`@​channel\`
      |  ${botUserIdMention} revoke \`@​user\` [\`@​others\` ...]
      |    Revoke user from using \`@​here\` / \`@​channel\`
      |  ${botUserIdMention} revoke all
      |    Revoke all users
      |  ${botUserIdMention} granted
      |    Show granted users
      |  ${botUserIdMention} public (on|off) (default: off)
      |    Set public mode.  If public mode is on, warning message will be posted globally.
      |  ${botUserIdMention} public
      |    Show public mode
      |  ${botUserIdMention} test
      |    Test warning message
      |  ${botUserIdMention} help
      |    Show this help message
    `.replace(/^\s*\|/gm, '').replace(/^\s*$/, '')

    return this.postMessage({
      text: helpMessage,
      private: isPrivate
    })
  }
}

class NoHereBot {
  constructor(client, rtm, repository) {
    this.client = client
    this.rtm = rtm
    this.repository = repository
  }

  setup() {
    this.rtm.on('ready', () => {
      this.handleReadyEvent()
        .catch((e) => console.error('Failed to handle ready event', e))
    })
    this.rtm.on('message', (m) => {
      this.handleMessageEvent(m)
        .catch((e) => console.error('Failed to handle message event', e))
    })
    return this
  }

  run() {
    this.rtm.start()
    return this
  }

  async handleReadyEvent() {
    console.log('ready')
  }

  async handleMessageEvent(message) {
    const botUserId = this.rtm.activeUserId

    if (message.hidden) {
      return
    }

    if (!message.subtype) {
      if (message.user === botUserId) {
        return
      }
      if (message.user === 'USLACKBOT') {
        return
      }
    }

    if (message.subtype && message.subtype === 'bot_message') {
      return
    }

    if (message.subtype && message.subtype === 'channel_join') {
      return
    }

    if (message.type !== 'message') {
      return
    }

    const postMessage = async (params) => {
      const args = Object.assign(
        {
          channel: message.channel,
          user: message.user,
          link_names: true,
          as_user: true
        },
        params
      )

      const isPrivate = args.private || false
      delete args.private
      if (isPrivate) {
        return this.client.chat.postEphemeral(args)
      } else {
        return this.client.chat.postMessage(args)
      }
    }

    const handler = new NoHereBotMessageHandler(this.repository, postMessage, message.channel, message.user, botUserId)
    return handler.handle(message.text)
  }
}

function runNoHereBot(slackToken, redisConnection) {
  if (slackToken === undefined) {
    slackToken = process.env.SLACK_TOKEN
  }
  if (redisConnection === undefined) {
    redisConnection = process.env.REDIS_URL
  }

  if (slackToken === undefined) {
    throw "SLACK_TOKEN not defined"
  }

  const repository =
    Redis !== undefined && redisConnection !== undefined ?
      new RedisSettingRepository(new Redis(redisConnection))
      : new MemorySettingRepository()

  const client = new WebClient(slackToken)
  const rtm = new RTMClient(slackToken)

  const bot = new NoHereBot(client, rtm, repository)
  bot.setup().run()
}

module.exports = {
  NoHereBot: NoHereBot,
  runNoHereBot: runNoHereBot,
  MemorySettingRepository: MemorySettingRepository,
  RedisSettingRepository: RedisSettingRepository
}
