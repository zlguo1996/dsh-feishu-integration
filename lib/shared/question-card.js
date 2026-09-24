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
/**
 * 选项**内联进按钮**的宽度上限（近似显示宽度：CJK 记 2、其余记 1）。
 *
 * 为什么需要它：飞书的按钮是**单行渲染**，文本一超行就被截成「…」，而按钮文本是
 * 用户唯一能看到选项内容的地方 —— 截了就等于「不知道该怎么选」。所以长选项改走
 * markdown 正文（可换行、完整显示），按钮退化成序号。
 *
 * 30 是保守值：手机端卡片正文内按钮一行大约能放 15 个汉字左右，留足余量后
 * 只有明显会截断的选项才会被拆出来，短选项保持「一键直点」的老样子。
 */
export const OPTION_INLINE_MAX_WIDTH = 30
/** 判定「宽字符」（CJK / 全角）用于估显示宽度。 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
const HEADER_TITLE = 'DSH 提问'

/** 近似显示宽度：宽字符 2、其余 1。用来判断一行放不放得下。 */
export function displayWidth(value) {
  let width = 0
  for (const ch of String(value ?? '')) width += WIDE_CHAR.test(ch) ? 2 : 1
  return width
}

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

/**
 * 单个选项按钮。
 * @param {boolean} [inline] true=把选项文本直接放在按钮上（短选项，一键直点）；
 *   false=按钮只显示序号，完整文本由调用方以 markdown 正文给出（长选项）。
 *   按钮是单行渲染，长文本放上去必然被截成「…」，所以长选项必须走后者。
 */
function optionButton({ rpcId, question, option, index, locked, chosenIndex, inline = true }) {
  const selected = locked && index === chosenIndex
  const label = inline
    ? clipText(option.label, OPTION_LABEL_MAX)
    : '选择 ' + (index + 1)
  return {
    tag: 'button',
    element_id: 'opt_' + index,
    type: selected ? 'primary_filled' : 'default',
    text: plainText((selected ? '✓ ' : '') + label),
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
    const label = String(option?.label ?? '')
    // 短选项：文本直接放按钮上，保持「一眼看清 + 一键直点」。
    // 长选项：先把**完整文本**放进正文（markdown 可换行），按钮退化成序号。
    //   按钮是单行渲染，文本一超行就被截成「…」；而按钮文本是用户唯一能看到
    //   选项内容的地方 —— 截了就等于「不知道该怎么选」。
    const inline = displayWidth(label) <= OPTION_INLINE_MAX_WIDTH
    if (!inline) elements.push(markdown('**' + (i + 1) + '.** ' + label))
    elements.push(optionButton({
      rpcId, question, option, index: i, locked: settled, chosenIndex, inline,
    }))
  }

  if (settled) {
    if (state === 'skipped') elements.push(markdown('⏭ **已跳过本次提问**'))
    else if (custom) elements.push(markdown('✍️ **自定义答案：' + clipText(custom, 300) + '**'))
    // 已选项同样不再按按钮上限截断：这里正是用户要看清「我刚选了什么」的地方。
    else elements.push(markdown('✅ **已选择：' + clipText(chosen?.label ?? '', 300) + '**'))
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
