import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canonicalJson,
  parseWatermarkKey,
  signWatermark,
  verifyWatermarkSignature
} from '../dist/core/watermark.js'

const key = Buffer.alloc(32, 7)

test('canonicalJson 与键顺序无关', () => {
  const a = canonicalJson({ b: 1, a: { y: 2, x: [3, { d: 4, c: 5 }] } })
  const b = canonicalJson({ a: { x: [3, { c: 5, d: 4 }], y: 2 }, b: 1 })
  assert.equal(a, b)
  assert.equal(a, '{"a":{"x":[3,{"c":5,"d":4}],"y":2},"b":1}')
})

test('签名字段为空时不影响结果', () => {
  const base = {
    schemaVersion: 1,
    buildId: 'b1',
    createdAt: '2026-01-01T00:00:00.000Z',
    files: { 'app.asar': 'sha256:00' }
  }
  const withUndefined = canonicalJson({ ...base, sig: undefined })
  assert.equal(withUndefined, canonicalJson(base))
})

test('签名可验证，篡改任一字段后失败', () => {
  const watermark = {
    schemaVersion: 1,
    buildId: 'b1',
    customer: 'acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    files: { 'app.asar': 'sha256:00' }
  }
  watermark.sig = signWatermark(watermark, key)
  assert.ok(verifyWatermarkSignature(watermark, key))
  assert.ok(!verifyWatermarkSignature({ ...watermark, customer: 'other' }, key))
  assert.ok(!verifyWatermarkSignature(watermark, Buffer.alloc(32, 8)))
})

test('密钥解析支持 hex 与 base64，长度错误直接报错', () => {
  assert.equal(parseWatermarkKey('00'.repeat(32)).length, 32)
  assert.equal(parseWatermarkKey(Buffer.alloc(32, 1).toString('base64')).length, 32)
  assert.throws(() => parseWatermarkKey('abcd'), /32 字节/)
})
