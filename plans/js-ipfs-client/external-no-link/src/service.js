'use strict'

const { Noise } = require('@web3-storage/libp2p-noise')
const libp2p = require('libp2p')
const Multiplex = require('libp2p-mplex')
const Websockets = require('libp2p-websockets')
const LRUCache = require('mnemonist/lru-cache')

const { cacheBlockInfo, cacheBlockInfoSize, cacheBlockData, cacheBlockDataSize, port, peerAnnounceAddr } = require('./config')
const { logger, serializeError } = require('./logging')
const { Connection } = require('./networking')
const { noiseCrypto } = require('./noise-crypto')
const { getPeerId } = require('./peer-id')
const { startKeepAlive, stopKeepAlive } = require('./p2p-keep-alive.js')
const { enableKeepAlive } = require('./config')
const {
  BITSWAP_V_120,
  Block,
  BlockPresence,
  emptyWantList,
  Entry,
  maxBlockSize,
  Message,
  protocols
} = require('./protocol')
const { cidToKey, defaultDispatcher, fetchBlockFromS3, searchCarInDynamoV1 } = require('./storage')
const { telemetry } = require('./telemetry')

const blockInfoCache = new LRUCache(cacheBlockInfoSize)
const blockDataCache = new LRUCache(cacheBlockDataSize)

function createEmptyMessage(blocks = [], presences = []) {
  return new Message(emptyWantList, blocks, presences, 0)
}

// size of block object in bytes
// block is { car: string, offset: number, length: number }
function sizeofBlock(block) {
  return block.car.length * 2 + 16
}

async function getBlockInfo(dispatcher, cid) {
  const key = cidToKey(cid)
  const cached = blockInfoCache.get(key)

  if (cacheBlockInfo) {
    if (cached) {
      telemetry.increaseCount('cache-block-info-hits')
      return cached
    }
    telemetry.increaseCount('cache-block-info-misses')
  }

  telemetry.increaseCount('dynamo-reads')
  const item = await telemetry.trackDuration(
    'dynamo-request',
    searchCarInDynamoV1({ dispatcher, blockKey: key, logger })
  )

  if (item) {
    blockInfoCache.set(key, item)
  }

  return item
}

async function fetchBlock(dispatcher, cid) {
  const info = await getBlockInfo(dispatcher, cid)
  if (!info) {
    return null
  }

  const { offset, length, car } = info

  if (length > maxBlockSize) {
    return null
  }

  const cacheKey = cidToKey(cid)
  if (cacheBlockData) {
    const bytes = blockDataCache.get(cacheKey)
    if (bytes) {
      telemetry.increaseCount('cache-block-data-hits')
      return bytes
    }
    telemetry.increaseCount('cache-block-data-misses')
  }

  const [, bucketRegion, bucketName, key] = car.match(/([^/]+)\/([^/]+)\/(.+)/)
  const bytes = await fetchBlockFromS3(dispatcher, bucketRegion, bucketName, key, offset, length)

  if (cacheBlockData) {
    blockDataCache.set(cacheKey, bytes)
  }

  return bytes
}

async function sendMessage(context, encodedMessage) {
  if (!context.connection) {
    telemetry.increaseCount('bitswap-total-connections')
    telemetry.increaseCount('bitswap-active-connections')

    const dialConnection = await context.service.dial(context.peer)
    const { stream } = await dialConnection.newStream(context.protocol)
    context.connection = new Connection(stream)
    context.connection.on('error', err => {
      logger.warn({ err }, `Outgoing connection error: ${serializeError(err)}`)
    })
  }

  context.connection.send(encodedMessage)
}

async function finalizeWantlist(context) {
  telemetry.decreaseCount('bitswap-pending-entries', context.total)

  // Once we have processed all blocks, see if there is anything else to send
  if (context.message.blocks.length || context.message.blockPresences.length) {
    await sendMessage(context, context.message.encode(context.protocol))
  }

  if (context.connection) {
    telemetry.decreaseCount('bitswap-active-connections')
    await context.connection.close()
  }
}

async function processEntry(entry, context) {
  try {
    let newBlock
    let newPresence

    if (entry.wantType === Entry.WantType.Block) {
      // Fetch the block and eventually append to the list of blocks
      const raw = await fetchBlock(context.dispatcher, entry.cid)

      if (raw) {
        telemetry.increaseCount('bitswap-block-data-hits')
        telemetry.increaseCount('bitswap-sent-data', raw.length)
        newBlock = new Block(entry.cid, raw)
      } else if (entry.sendDontHave && context.protocol === BITSWAP_V_120) {
        telemetry.increaseCount('bitswap-block-data-misses')
        newPresence = new BlockPresence(entry.cid, BlockPresence.Type.DontHave)
        logger.warn({ entry, cid: entry.cid.toString() }, 'Block not found')
      }
    } else if (entry.wantType === Entry.WantType.Have && context.protocol === BITSWAP_V_120) {
      // Check if we have the block
      const existing = await getBlockInfo(context.dispatcher, entry.cid)

      if (existing) {
        telemetry.increaseCount('bitswap-block-info-hits')
        telemetry.increaseCount('bitswap-sent-info', sizeofBlock(existing))
        newPresence = new BlockPresence(entry.cid, BlockPresence.Type.Have)
      } else if (entry.sendDontHave) {
        telemetry.increaseCount('bitswap-block-info-misses')
        newPresence = new BlockPresence(entry.cid, BlockPresence.Type.DontHave)
        logger.warn({ entry, cid: entry.cid.toString() }, 'Block not found')
      }
    }

    /*
    In the if-else below, addBlock and addPresence returns false if adding
    the element would make the serialized message exceed the maximum allowed size.

    In that case, we send the message without the new element and prepare a new message.

    The reason why don't encode the message to send in sendMessage is because we need to
    create a new message before sending is actually tried.
    This is to avoid a race condition (and duplicate data sent) in environments when remote peer download
    speed is comparable to Dynamo+S3 read time. (e.g. inter AWS peers).
  */
    if (newBlock) {
      if (!context.message.addBlock(newBlock, context.protocol)) {
        const toSend = context.message.encode(context.protocol)
        context.message = createEmptyMessage([newBlock])
        await sendMessage(context, toSend)
      }
    } else if (newPresence) {
      if (!context.message.addBlockPresence(newPresence, context.protocol)) {
        const toSend = context.message.encode(context.protocol)
        context.message = createEmptyMessage([], [newPresence])
        await sendMessage(context, toSend)
      }
    }

    // TODO move outside this function
    context.pending--
    if (context.pending === 0) {
      await finalizeWantlist(context)
    }
  } catch (err) {
    logger.error({ err, entry }, `Cannot process an entry: ${serializeError(err)}`)
  }
}

function processWantlist(context) {
  if (!context.wantlist.entries.length) {
    return
  }

  // Every tick we schedule up to 100 entries, this is not to block the Event Loop too long
  const batch = context.wantlist.entries.splice(0, 100)

  for (let i = 0, length = batch.length; i < length; i++) {
    if (batch[i].cancel) {
      context.pending--
      continue
    }

    processEntry(batch[i], context)
  }

  // The list only contains cancels
  if (context.pending === 0) {
    finalizeWantlist(context)
    return
  }

  process.nextTick(processWantlist, context)
}

async function startService({ peerId, currentPort, dispatcher, announceAddr } = {}) {
  try {
    if (!peerId) {
      peerId = await getPeerId()
    }

    if (!dispatcher) {
      dispatcher = defaultDispatcher
    }

    if (!currentPort) {
      currentPort = port
    }

    if (!announceAddr) {
      announceAddr = peerAnnounceAddr
    }

    const service = await libp2p.create({
      peerId,
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${currentPort}/ws`],
        announce: announceAddr ? [announceAddr] : undefined
      },
      modules: {
        transport: [Websockets],
        streamMuxer: [Multiplex],
        connEncryption: [new Noise(null, null, noiseCrypto)]
      }
    })

    service.on('error', err => {
      logger.warn({ err }, `libp2p error: ${serializeError(err)}`)
    })

    service.handle(protocols, async ({ connection: dial, stream, protocol }) => {
      try {
        const connection = new Connection(stream)

        // Open a send connection to the peer
        connection.on('data', data => {
          let message

          try {
            message = Message.decode(data, protocol)
          } catch (err) {
            logger.warn({ err }, `Cannot decode received data: ${serializeError(err)}`)
            service.emit('error:receive', err)
            return
          }

          const entries = message.wantlist.entries.length
          try {
            const context = {
              service,
              dispatcher,
              peer: dial.remotePeer,
              protocol,
              wantlist: message.wantlist,
              total: entries,
              pending: entries,
              message: createEmptyMessage()
            }

            telemetry.increaseCount('bitswap-total-entries', context.total)
            telemetry.increaseCount('bitswap-pending-entries', entries.total)
            process.nextTick(processWantlist, context)
          } catch (err) {
            logger.warn({ err }, `Error while preparing wantList context: ${serializeError(err)}`)
          }
        })

        // When the incoming duplex stream finishes sending, close for writing.
        // Note: we never write to this stream - responses are always sent on
        // another multiplexed stream.
        connection.on('end:receive', () => connection.close())

        /* c8 ignore next 4 */
        connection.on('error', err => {
          logger.error({ err, dial, stream, protocol }, `Connection error: ${serializeError(err)}`)
          service.emit('error:connection', err)
        })
      } catch (err) {
        logger.error({ err, dial, stream, protocol }, `Error while creating connection: ${serializeError(err)}`)
      }
    })

    service.connectionManager.on('peer:connect', connection => {
      try {
        if (enableKeepAlive) { startKeepAlive(connection.remotePeer, service) }
        telemetry.increaseCount('bitswap-total-connections')
        telemetry.increaseCount('bitswap-active-connections')
      } catch (err) {
        logger.warn({ err, remotePeer: connection.remotePeer }, `Error while peer connecting: ${serializeError(err)}`)
      }
    })

    service.connectionManager.on('peer:disconnect', connection => {
      try {
        if (enableKeepAlive) { stopKeepAlive(connection.remotePeer) }
        telemetry.decreaseCount('bitswap-active-connections')
      } catch (err) {
        logger.warn({ err, remotePeer: connection.remotePeer }, `Error while peer disconnecting: ${serializeError(err)}`)
      }
    })

    service.connectionManager.on('error', err => {
      logger.error({ err }, `libp2p connectionManager.error: ${serializeError(err)}`)
    })

    service.connectionManager.on('connection', connection => {
      logger.debug({ connection }, ' ******** connectionManager.on connection')
    })

    service.connectionManager.on('connectionEnd', connection => {
      logger.debug({ connection }, ' ******** connectionManager.on connectionEnd')
    })

    await service.start()

    logger.info(
      { address: service.transportManager.getAddrs() },
      `BitSwap peer started with PeerId ${service.peerId} and listening on port ${currentPort} ...`
    )

    return { service, port: currentPort, peerId }
    /* c8 ignore next 3 */
  } catch (err) {
    logger.error({ err }, 'Error on service')
  }
}

module.exports = { startService }
