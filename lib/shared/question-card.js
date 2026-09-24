/**
 * 提问卡片（卡片 JSON 2.0）：把一轮 ask_user_question 渲染成可直接点选的交互卡片。
 *
 * 与本插件既有约定的关系：
 * - 一轮只呈现一个问题（question-bridge 按题串行推进），所以卡片是单题的。
 * - 选项按钮用 `behaviors:[{type:'callback', value}]` 回传，点一下即作答。
 * - 「其他」自定义输入必须与提交按钮同处表单容器（官方要求：输入框要配合按钮使用），
 *   提交后从回调的 `action.form_value` 取文本；表单容器只能位于卡片根节点，
 *   且内部必须至少有一个带 `form_action_type:'submit'` 的按钮。
 * - 不引入新概念：回调的共 answer / custom / skip 三种，分别落到
 *   `AskUserQuestionAnswerItem` 的 selected / custom / 空 selected（跳过的既有表示）。
 *
 * 客户端门禁：卡片 JSON 2.0 需客户端 ≥7.20；低于该版本时卡片正文只显示升级提示。
 * 因此调用方**必须**在发卡失败时回退纯文本 —— 提问卡渲染不出来等于答不了。
 *
 * `element_id` 约束（官方）：卡内全局唯一、仅字母数字下划线、字母开头、≤20 字符。
 */

/** 选项多于这个数就不用按钮（卡片会太高），改由纯文本兜底呈现。 */
export const OPTION_AS_BUTTON_MAX = 5
/** 飞书输入框上限。 */
export const CUSTOM_INPUT_MAX_LENGTH = 1000
/** 按钮文本官方上限 100，这里留余量。 */
const OPTION_LABEL_MAX = 60
const HEADER_TITLE = 'DSH 提问'

function clipText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…'
}

const plainText = (content) => ({ tag: 'plain_text', content })
const markdown = (content) => ({ tag: 'markdown', content })

/**
 * 该问题能否用「选项按钮 + 其他输入」呈现。
 * 多选题不用这套：飞书多选要走 checker + 表单提交，schema 与单选不同。
 * @param {object} question 单个 AskUserQuestionItem
 * @returns {boolean}
 */
export function supportsOptionCard(question) {
  return question?.multiSelect !== true
    && Array.isArray(question?.options)
    && question.options.length > 0
    && question.options.length <= OPTION_AS_BUTTON_MAX
}

function optionButton({ rpcId, question, option, index, locked, chosenIndex }) {
  const selected = locked && index === chosenIndex
  return {
    tag: 'button',
    element_id: 'opt_' + index,
    type: selected ? 'primary_filled' : 'default',
    text: plainText((selected ? '✓ ' : '') + clipText(option.label, OPTION_LABEL_MAX)),
    // 一旦有结论（已答/已跳过）就锁死全部选项，避免二次作答。
    disabled: locked,
    behaviors: [{
      type: 'callback',
      value: { rpcId, questionId: question.id, kind: 'answer', optionIndex: index, option: option.label },
    }],
  }
}

function customForm({ rpcId, question }) {
  return {
    tag: 'form',
    name: 'form_custom',
    elements: [
      {
        tag: 'input',
        element_id: 'custom_input',
        name: 'custom_text',
        label: plainText('其他（自定义输入）'),
        placeholder: plainText('也可以直接打字回答'),
        input_type: 'multiline_text',
        rows: 2,
        auto_resize: true,
        max_length: CUSTOM_INPUT_MAX_LENGTH,
      },
      {
        tag: 'button',
        element_id: 'custom_submit',
        name: 'submit_custom',
        type: 'primary',
        text: plainText('提交自定义答案'),
        form_action_type: 'submit',
        // 提交按钮的 behaviors.value 会随 form 回调的 action.value 一起回来。
        behaviors: [{ type: 'callback', value: { rpcId, questionId: question.id, kind: 'custom' } }],
      },
    ],
  }
}

function skipButton({ rpcId, question }) {
  return {
    tag: 'button',
    element_id: 'skip',
    type: 'text',
    text: plainText('跳过本次提问'),
    behaviors: [{ type: 'callback', value: { rpcId, questionId: question.id, kind: 'skip' } }],
  }
}

/**
 * 构造一轮提问的卡片。
 * @param {object} o
 * @param {string} o.rpcId 该轮提问的桥 ID，回调按它路由回批次
 * @param {object} o.question 单个 AskUserQuestionItem
 * @param {number} [o.index] 第几题（从 1 起）
 * @param {number} [o.total] 共几题
 * @param {'pending'|'answered'|'skipped'} [o.state] 卡片状态
 * @param {number|null} [o.chosenIndex] 已选项下标（answered 时）
 * @param {string|null} [o.custom] 已提交的自定义文本
 * @returns {object|null} 卡片 JSON；该问题不适用选项卡片时返回 null，由调用方回退纯文本
 */
export function buildQuestionCard({
  rpcId, question, index = 1, total = 1, state = 'pending', chosenIndex = null, custom = null,
}) {
  if (!supportsOptionCard(question)) return null
  const options = question.options
  const settled = state !== 'pending'
  const chosen = options[chosenIndex]

  const elements = [markdown('**' + clipText(question.question, 300) + '**')]
  if (question.detail) elements.push(markdown(String(question.detail)))
  for (const [i, option] of options.entries()) {
    elements.push(optionButton({ rpcId, question, option, index: i, locked: settled, chosenIndex }))
  }

  if (settled) {
    if (state === 'skipped') elements.push(markdown('⏭ **已跳过本次提问**'))
    else if (custom) elements.push(markdown('✍️ **自定义答案：' + clipText(custom, 300) + '**'))
    else elements.push(markdown('✅ **已选择：' + clipText(chosen?.label ?? '', OPTION_LABEL_MAX) + '**'))
    // 已答/已跳过都不再保留「跳过本次提问」按钮：问题已有结论，留着只是占位。
  } else {
    elements.push(customForm({ rpcId, question }))
    elements.push(skipButton({ rpcId, question }))
  }

  const summary = state === 'pending'
    ? HEADER_TITLE + '：' + clipText(question.question, 80)
    : HEADER_TITLE + '（' + (state === 'skipped' ? '已跳过' : '已回答') + '）'
  const titleSuffix = state === 'pending' ? index + '/' + total : (state === 'skipped' ? '已跳过' : '已选择')

  return {
    schema: '2.0',
    // update_multi 必须为 true：共享卡片才支持事后用 im/messages/{id} 更新（14 天内）。
    config: { update_multi: true, summary: { content: summary } },
    header: {
      template: state === 'pending' ? 'blue' : (state === 'skipped' ? 'grey' : 'green'),
      title: plainText(HEADER_TITLE + ' · ' + titleSuffix),
    },
    body: { elements },
  }
}
