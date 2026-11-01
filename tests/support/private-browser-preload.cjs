// 只供本地合成验收的进程 preload；应用不导入此文件，没有生产测试开关。
'use strict'
const fixed = {
  IMAGE_PRIVATE_HTTP_ACCEPTANCE: '1', IMAGE_DATABASE_TARGET: 'local',
  IMAGE_DATABASE_URL: 'postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image',
  COS_BUCKET: 'synthetic-private-1234567890', COS_REGION: 'ap-shanghai',
  COS_SECRET_ID: 'synthetic-cos-secret-id', COS_SECRET_KEY: 'synthetic-cos-secret-key',
}
for (const [name, value] of Object.entries(fixed)) if (process.env[name] !== value) throw new Error(`Synthetic acceptance environment refused: ${name}`)
if (!['http://localhost:3108', 'https://acceptance.image.test'].includes(process.env.BETTER_AUTH_URL)) throw new Error('Synthetic acceptance origin refused')

const { createHash } = require('node:crypto')
const { deflateSync } = require('node:zlib')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const Module = require('node:module')
const https = require('node:https')
const http = require('node:http')
const dns = require('node:dns/promises')
const objects = new Map()
const state = { modelCalls: 0, writes: 0, reads: 0, blockedHttps: 0, faults: 0, requests: [], outputs: [] }
let failCompletionManifest = false
let delayNextReadMs = 0
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const keyPattern = /^image-playground\/private\/v1\/[0-9a-f]{64}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(?:manifest\.json|outputs\/final|inputs\/(?:reference-[12]|document-image-[12]|document))$/
function checkObject(params) {
  if (params.Bucket !== fixed.COS_BUCKET || params.Region !== fixed.COS_REGION || !keyPattern.test(params.Key)) throw new Error('Synthetic object target refused')
}
const patched = new WeakSet()
function patchCos(COS) {
  if (typeof COS !== 'function' || patched.has(COS)) return COS
  patched.add(COS)
  COS.prototype.putObject = function (params, callback) {
    try {
      checkObject(params)
      if (params.ACL !== 'private' || params.CacheControl !== 'private, no-store' || !Buffer.isBuffer(params.Body)) throw new Error('Synthetic object contract refused')
      if (params.Key.endsWith('/manifest.json') && failCompletionManifest && JSON.parse(params.Body).status === 'complete') {
        failCompletionManifest = false; state.faults++
        queueMicrotask(() => callback(new Error('Synthetic completion manifest failure')))
        return
      }
      const bytes = Buffer.from(params.Body)
      objects.set(params.Key, { bytes, mediaType: params.ContentType })
      state.writes++
      queueMicrotask(() => callback(null, { statusCode: 200 }))
    } catch (error) { queueMicrotask(() => callback(error)) }
  }
  COS.prototype.getObject = function (params, callback) {
    try {
      checkObject(params)
      const object = objects.get(params.Key)
      const range = /^bytes=0-([0-9]+)$/.exec(params.Range)
      if (!object || !range) throw new Error('Synthetic object missing')
      const body = object.bytes.subarray(0, Number(range[1]) + 1)
      state.reads++
      const delay = delayNextReadMs; delayNextReadMs = 0
      setTimeout(() => callback(null, { statusCode: 206, Body: Buffer.from(body), headers: {
        'content-type': object.mediaType, 'content-length': String(body.length), 'content-range': `bytes 0-${body.length - 1}/${object.bytes.length}`,
      } }), delay)
    } catch (error) { queueMicrotask(() => callback(error)) }
  }
  return COS
}
const originalLoad = Module._load
Module._load = function (name, parent, main) {
  const loaded = originalLoad.call(this, name, parent, main)
  // Turbopack standalone 为外置包生成带固定内容摘要的别名。
  return /^cos-nodejs-sdk-v5(?:-[0-9a-f]{16})?$/.test(name) ? patchCos(loaded) : loaded
}
// 包括 standalone 中独立路径的 SDK 副本，每个构造器均只 patch 一次。
patchCos(require('cos-nodejs-sdk-v5'))

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
function syntheticPng(index) {
  const width = 320, height = 240, rowSize = width * 3 + 1
  const rows = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * rowSize + 1 + x * 3
    rows[offset] = (48 + x + index * 31) % 256
    rows[offset + 1] = (100 + y + index * 19) % 256
    rows[offset + 2] = (170 + index * 43) % 256
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
}
const realLookup = dns.lookup
dns.lookup = async function (host, options) {
  if (host === 'synthetic-provider.example') return options?.all ? [{ address: '8.8.8.8', family: 4 }] : { address: '8.8.8.8', family: 4 }
  return realLookup.call(this, host, options)
}
https.request = function (options, callback) {
  const request = new EventEmitter()
  request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); return request }
  request.end = body => {
    void (async () => {
      if (options.servername !== 'synthetic-provider.example' || options.hostname !== '8.8.8.8' || options.method !== 'POST' ||
          !['/v1/images/generations', '/v1/images/edits'].includes(options.path) || options.headers?.authorization !== 'Bearer synthetic-provider-token') {
        state.blockedHttps++; throw new Error('All non-synthetic HTTPS is blocked by acceptance preload')
      }
      options.signal?.throwIfAborted()
      let prompt, model, images = []
      if (options.path.endsWith('/edits')) {
        const form = await new Response(body, { headers: { 'content-type': options.headers['content-type'] } }).formData()
        model = form.get('model'); prompt = form.get('prompt')
        for (const [key, value] of form.entries()) if (key === 'image' || key === 'image[]') images.push(hash(Buffer.from(await value.arrayBuffer())))
      } else {
        const data = JSON.parse(Buffer.from(body).toString()); model = data.model; prompt = data.prompt
      }
      if (model !== 'synthetic-actual-model' || typeof prompt !== 'string') throw new Error('Synthetic model contract refused')
      state.modelCalls++
      state.requests.push({ path: options.path, prompt, imageHashes: images })
      const output = syntheticPng(state.modelCalls)
      state.outputs.push({ sha256: hash(output), byteLength: output.length })
      const response = Readable.from([Buffer.from(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }))])
      response.statusCode = 200; response.headers = { 'content-type': 'application/json' }
      callback(response)
    })().catch(error => request.emit('error', error))
    return request
  }
  return request
}
Module.syncBuiltinESMExports()

const originalEmit = http.Server.prototype.emit
http.Server.prototype.emit = function (event, request, response, ...rest) {
  if (event !== 'request' || !request.url?.startsWith('/__synthetic_acceptance__/')) return originalEmit.call(this, event, request, response, ...rest)
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json')
  if (request.method === 'GET' && request.url === '/__synthetic_acceptance__/state') {
    response.end(JSON.stringify({ ...state, objects: objects.size, realModelCalls: 0, realCloudWrites: 0 })); return true
  }
  if (request.method === 'POST' && request.url === '/__synthetic_acceptance__/fault') {
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 512) request.destroy() })
    request.on('end', () => {
      try {
        const input = JSON.parse(body)
        if (JSON.stringify(input) === '{"failNextCompletionManifest":true}') failCompletionManifest = true
        else if (Object.keys(input).length === 1 && Number.isInteger(input.delayNextReadMs) && input.delayNextReadMs >= 1 && input.delayNextReadMs <= 1000) delayNextReadMs = input.delayNextReadMs
        else throw new Error('unsupported fault')
        response.end('{"armed":true}')
      } catch { response.statusCode = 400; response.end('{"error":"unsupported synthetic fault"}') }
    })
    return true
  }
  response.statusCode = 404; response.end('{"error":"unknown synthetic endpoint"}'); return true
}
