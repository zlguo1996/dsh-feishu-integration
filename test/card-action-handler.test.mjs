/**
 * card.action.trigger 处理器回归（真实 inbound-runtime + 假 Lark SDK）：
 * 锁住与飞书之间的**线格式**，这是整条链路里最容易悄悄改坏的一层：
 *   - 按钮点击 → 解析出 {rpcId, questionId, kind, option, optionIndex}；
 *   - 表单提交 → 从 action.form_value 取自定义文本；
 *   - 回调响应必须是 { toast, card: { type:'raw', data } } 这种结构；
 *   - **绝不能返回裸字符串**：没有 handler 时 Lark SDK 会把
 *     `no card.action.trigger event handle` 当响应返回，客户端就报 200672，
 *     所以处理器任何分支都必须回对象；
 *   - 处理器抛错也不能把异常抛回 SDK（否则同样得到非法响应）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { startInboundForBot } from '../lib/host/inbound-runtime.js'

function makeFakeLark() {
  const dispatchers = []
  class EventDispatcher {
    register(handlers) { Object.assign(this, handlers); return this }
  }
  class WSClient {
    async start({ eventDispatcher }) { this.dispatcher = eventDispatcher; dispatchers.push(eventDispatcher) }
    close() { /* noop */ }
  }
  class Client {
    im = {
      v1: {
        message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }) },
        messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
      },
    }
  }
  return { Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 'info' }, EventDispatcher, WSClient, Client, __dispatchers: dispatchers }
}

const BOT = { id: 'bot_x', appId: 'cli_a', secretRef: 'ref', botName: '测试机器人' }

/** 起一个真实入站运行时，取回它注册的事件分发器。omitHandler=true 模拟提问桥未启用。 */
async function boot({ handler, omitHandler = false } = {}) {
  const larkSdk = makeFakeLark()
  const calls = []
  await startInboundForBot({
    origin: 'http://127.0.0.1:1',
    workspace: '/tmp/proj-w',
    agentPreset: 'standard',
    replyTimeoutMs: 1000,
    replyMaxChars: 9000,
    bot: BOT,
    appSecret: 's3cret',
    record: null,
    larkSdk,
    helpers: {
      log: () => {},
      debugLog: () => {},
      lookupReplyMapping: () => null,
      recordReplyMapping: () => {},
      readBotState: () => ({ version: 1, sessions: {}, seenMessageIds: [] }),
      writeBotState: () => {},
      ...(omitHandler ? {} : {
        handleCardAction: async (request) => {
          calls.push(request)
          return handler ? handler(request) : {
            toast: { type: 'success', content: '已选择' },
            card: { schema: '2.0', body: { elements: [] } },
          }
        },
      }),
    },
  })
  return { dispatcher: larkSdk.__dispatchers[0], calls }
}

test('按钮点击：解析出作答，并回 {toast, card:{type:"raw",data}} 结构', async () => {
  const { dispatcher, calls } = await boot()
  const out = await dispatcher['card.action.trigger']({
    operator: { open_id: 'ou_u1' },
    action: {
      tag: 'button',
      value: { rpcId: 'rq1', questionId: 'qq1', kind: 'answer', option: 'Docker', optionIndex: 0 },
    },
    context: { open_message_id: 'om_card_1', open_chat_id: 'oc_1' },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    rpcId: 'rq1',
    questionId: 'qq1',
    kind: 'answer',
    option: 'Docker',
    optionIndex: 0,
    customText: '',
    messageId: 'om_card_1',
    chatId: 'oc_1',
    operator: 'ou_u1',
  })
  assert.equal(out.toast.type, 'success')
  assert.equal(out.card.type, 'raw', 'raw = data 是完整卡片 JSON')
  assert.equal(out.card.data.schema, '2.0')
})

test('表单提交：自定义文本从 action.form_value 取（提交按钮的 value 仍来自 action.value）', async () => {
  const { dispatcher, calls } = await boot()
  await dispatcher['card.action.trigger']({
    action: {
      tag: 'button',
      name: 'submit_custom',
      form_value: { custom_text: '先在本地试一版' },
      value: { rpcId: 'rq2', questionId: 'qq1', kind: 'custom' },
    },
    context: { open_message_id: 'om_card_2' },
  })
  assert.equal(calls[0].kind, 'custom')
  assert.equal(calls[0].customText, '先在本地试一版')
  assert.equal(calls[0].rpcId, 'rq2')
})

test('表单文本会裁剪首尾空白；缺 form_value 时退化为空串', async () => {
  const { dispatcher, calls } = await boot()
  await dispatcher['card.action.trigger']({
    action: { tag: 'input', input_value: '  裸机  ', value: { rpcId: 'rq3', kind: 'custom' } },
    context: {},
  })
  assert.equal(calls[0].customText, '裸机', '单独输入框走 input_value')
  await dispatcher['card.action.trigger']({ action: { value: { rpcId: 'rq4', kind: 'answer' } }, context: {} })
  assert.equal(calls[1].customText, '')
})

test('缺省 kind 视为 answer；缺 rpcId 也要能安全走完（不抛）', async () => {
  const { dispatcher, calls } = await boot()
  await dispatcher['card.action.trigger']({ action: { value: {} }, context: {} })
  assert.equal(calls[0].kind, 'answer')
  assert.equal(calls[0].rpcId, null)
})

test('提问桥未启用时回合法对象（绝不返回裸字符串 —— 那正是 200672 的成因）', async () => {
  const { dispatcher } = await boot({ omitHandler: true })
  const out = await dispatcher['card.action.trigger']({ action: { value: {} }, context: {} })
  assert.equal(typeof out, 'object')
  assert.ok(out !== null)
  assert.equal(out.toast.type, 'warning')
  assert.ok(!('card' in out), '不更新卡片时不应带 card 字段')
})

test('处理器只回 toast（方式二：不更新卡片）时不带 card 字段', async () => {
  const { dispatcher } = await boot({ handler: () => ({ toast: { type: 'warning', content: '该提问已结束' }, card: null }) })
  const out = await dispatcher['card.action.trigger']({ action: { value: {} }, context: {} })
  assert.equal(out.toast.type, 'warning')
  assert.ok(!('card' in out))
})

test('处理器抛错 → 回错误 toast，不把异常抛回 SDK', async () => {
  const { dispatcher } = await boot({ handler: () => { throw new Error('boom') } })
  const out = await dispatcher['card.action.trigger']({ action: { value: { rpcId: 'x', kind: 'answer' } }, context: {} })
  assert.equal(out.toast.type, 'error')
  assert.ok(!('card' in out))
})

test('处理器返回被拒绝的 Promise 同样兜成错误 toast', async () => {
  const { dispatcher } = await boot({ handler: () => Promise.reject(new Error('async boom')) })
  const out = await dispatcher['card.action.trigger']({ action: { value: {} }, context: {} })
  assert.equal(out.toast.type, 'error')
})
