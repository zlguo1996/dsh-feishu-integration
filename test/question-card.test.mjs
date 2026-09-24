import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQuestionCard,
  supportsOptionCard,
  OPTION_AS_BUTTON_MAX,
  CUSTOM_INPUT_MAX_LENGTH,
} from '../lib/shared/question-card.js'

const QUESTION = {
  id: 'pack',
  question: '打包要不要带上测试环境？',
  detail: '影响构建产物体积。',
  options: [
    { label: '带上测试环境' },
    { label: '不带' },
  ],
}

const card = (over = {}) => buildQuestionCard({ rpcId: 'r1', question: QUESTION, ...over })

/** 收集卡内所有 element_id（含嵌套），用于校验官方命名约束。 */
function collectElementIds(cardValue, out = []) {
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (node === null || typeof node !== 'object') return
    if (typeof node.element_id === 'string') out.push(node.element_id)
    for (const value of Object.values(node)) walk(value)
  }
  walk(cardValue.body?.elements ?? [])
  return out
}

function flatten(cardValue, out = []) {
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (node === null || typeof node !== 'object') return
    out.push(node)
    for (const value of Object.values(node)) walk(value)
  }
  walk(cardValue.body?.elements ?? [])
  return out
}

const byTag = (cardValue, tag) => flatten(cardValue).filter((n) => n.tag === tag)

// ── 适用范围 ──────────────────────────────────────────────────────────────

test('supportsOptionCard：单选且有选项时可用；多选/无选项/超量时不可用', () => {
  assert.equal(supportsOptionCard(QUESTION), true)
  assert.equal(supportsOptionCard({ ...QUESTION, multiSelect: true }), false)
  assert.equal(supportsOptionCard({ id: 'x', question: 'q' }), false)
  assert.equal(supportsOptionCard({ ...QUESTION, options: [] }), false)
  assert.equal(supportsOptionCard({
    ...QUESTION,
    options: Array.from({ length: OPTION_AS_BUTTON_MAX + 1 }, (_, i) => ({ label: 'o' + i })),
  }), false)
})

test('不适用的形态返回 null，由调用方回退纯文本', () => {
  assert.equal(card({ question: { ...QUESTION, multiSelect: true } }), null)
  assert.equal(card({ question: { id: 'x', question: 'no options' } }), null)
})

// ── 待答态 ────────────────────────────────────────────────────────────────

test('待答态：每个选项一个可点按钮，回传 kind=answer 与选项原文', () => {
  const c = card()
  assert.equal(c.schema, '2.0')
  assert.equal(c.header.template, 'blue')
  assert.equal(c.config.update_multi, true, '共享卡片才支持事后 im/messages 更新')

  const buttons = byTag(c, 'button')
  // 2 个选项 + 1 个表单提交 + 1 个跳过
  assert.equal(buttons.length, 4)
  const answerButtons = buttons.filter((b) => b.behaviors?.[0]?.value?.kind === 'answer')
  assert.equal(answerButtons.length, 2)
  assert.deepEqual(answerButtons.map((b) => b.text.content), ['带上测试环境', '不带'])
  assert.equal(answerButtons[0].behaviors[0].value.option, '带上测试环境')
  assert.equal(answerButtons[0].behaviors[0].value.optionIndex, 0)
  assert.equal(answerButtons[0].behaviors[0].value.rpcId, 'r1')
  assert.equal(answerButtons[0].behaviors[0].value.questionId, 'pack')
  assert.ok(answerButtons.every((b) => b.disabled !== true), '待答态不应锁死选项')
})

test('待答态：问题与 detail 都呈现出来', () => {
  const c = card()
  const texts = byTag(c, 'markdown').map((m) => m.content)
  assert.ok(texts.some((t) => t.includes('打包要不要带上测试环境')))
  assert.ok(texts.some((t) => t.includes('影响构建产物体积')))
})

test('待答态：自定义输入落在 form 里，且 form 内有 submit 按钮（官方硬要求）', () => {
  const c = card()
  const forms = byTag(c, 'form')
  assert.equal(forms.length, 1)
  assert.equal(forms[0].name, 'form_custom')
  assert.ok(forms[0].elements.some((el) => el.form_action_type === 'submit'), 'form 内必须有 submit 按钮')

  const inputs = byTag(c, 'input')
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].name, 'custom_text', 'form 内的交互组件 name 必填')
  assert.equal(inputs[0].max_length, CUSTOM_INPUT_MAX_LENGTH)
  assert.ok(CUSTOM_INPUT_MAX_LENGTH <= 1000, '飞书输入框上限 1000')

  const submit = forms[0].elements.find((el) => el.form_action_type === 'submit')
  assert.equal(submit.behaviors[0].value.kind, 'custom')
  assert.equal(submit.name, 'submit_custom')
})

test('待答态：跳过按钮叫「跳过本次提问」且回传 kind=skip', () => {
  const c = card()
  const skip = byTag(c, 'button').find((b) => b.behaviors?.[0]?.value?.kind === 'skip')
  assert.ok(skip, '待答态应有跳过按钮')
  assert.equal(skip.text.content, '跳过本次提问')
  assert.equal(skip.behaviors[0].value.questionId, 'pack')
})

test('表单容器位于卡片根节点（官方要求：不可被其它组件嵌套）', () => {
  const c = card()
  const root = c.body.elements
  assert.ok(root.some((el) => el.tag === 'form'), 'form 应在 body.elements 顶层')
  const nestedForm = flatten(c).filter((n) => n !== undefined)
  // form 自身只能在根层出现，且内部不得再有 form
  const forms = nestedForm.filter((n) => n.tag === 'form')
  assert.equal(forms.length, 1)
  assert.ok(!forms[0].elements.some((el) => el.tag === 'form'))
})

// ── 已答态 ────────────────────────────────────────────────────────────────

test('已答态：选中项高亮加勾、其余置灰，且全部锁定', () => {
  const c = card({ state: 'answered', chosenIndex: 1 })
  assert.equal(c.header.template, 'green')
  const answerButtons = byTag(c, 'button').filter((b) => b.behaviors?.[0]?.value?.kind === 'answer')
  assert.equal(answerButtons[0].type, 'default')
  assert.equal(answerButtons[0].text.content, '带上测试环境')
  assert.equal(answerButtons[1].type, 'primary_filled')
  assert.equal(answerButtons[1].text.content, '✓ 不带')
  assert.ok(answerButtons.every((b) => b.disabled === true), '已答态应锁死全部选项')
  assert.ok(byTag(c, 'markdown').some((m) => m.content.includes('已选择：不带')))
})

test('已答态：删掉跳过按钮与表单（问题已有结论，不留占位）', () => {
  const c = card({ state: 'answered', chosenIndex: 0 })
  assert.equal(byTag(c, 'button').filter((b) => b.behaviors?.[0]?.value?.kind === 'skip').length, 0)
  assert.equal(byTag(c, 'form').length, 0)
  assert.equal(byTag(c, 'input').length, 0)
})

test('已答态：自定义答案单独呈现', () => {
  const c = card({ state: 'answered', chosenIndex: null, custom: '先不打包，等我确认' })
  assert.equal(c.header.template, 'green')
  assert.ok(byTag(c, 'markdown').some((m) => m.content.includes('先不打包，等我确认')))
})

// ── 跳过态 ────────────────────────────────────────────────────────────────

test('跳过态：置灰表头、标注已跳过、同样不留跳过按钮', () => {
  const c = card({ state: 'skipped' })
  assert.equal(c.header.template, 'grey')
  assert.ok(byTag(c, 'markdown').some((m) => m.content.includes('已跳过本次提问')))
  assert.equal(byTag(c, 'button').filter((b) => b.behaviors?.[0]?.value?.kind === 'skip').length, 0)
  const answerButtons = byTag(c, 'button').filter((b) => b.behaviors?.[0]?.value?.kind === 'answer')
  assert.ok(answerButtons.every((b) => b.disabled === true))
})

// ── element_id 官方约束 ───────────────────────────────────────────────────

test('element_id：卡内唯一、字母开头、仅字母数字下划线、不超过 20 字符', () => {
  for (const over of [{}, { state: 'answered', chosenIndex: 0 }, { state: 'skipped' }]) {
    const ids = collectElementIds(card(over))
    assert.ok(ids.length > 0)
    assert.equal(new Set(ids).size, ids.length, 'element_id 必须唯一：' + ids.join(','))
    for (const id of ids) {
      assert.match(id, /^[A-Za-z][A-Za-z0-9_]*$/, '非法 element_id：' + id)
      assert.ok(id.length <= 20, 'element_id 超过 20 字符：' + id)
    }
  }
})

test('标题带题号，摘要进 config.summary.content（聊天列表预览用）', () => {
  const c = card({ index: 2, total: 3 })
  assert.equal(c.header.title.content, 'DSH 提问 · 2/3')
  assert.ok(c.config.summary.content.includes('打包要不要带上测试环境'))
  const answered = card({ state: 'answered', chosenIndex: 0, index: 2, total: 3 })
  assert.equal(answered.header.title.content, 'DSH 提问 · 已选择')
})

test('按钮文本超长会截断，避免超出按钮可容纳字符数', () => {
  const long = '选' + 'x'.repeat(120)
  const c = card({ question: { ...QUESTION, options: [{ label: long }, { label: '不带' }] } })
  const buttons = byTag(c, 'button').filter((b) => b.behaviors?.[0]?.value?.kind === 'answer')
  assert.ok(buttons[0].text.content.length <= 60)
  assert.ok(buttons[0].text.content.endsWith('…'))
})
