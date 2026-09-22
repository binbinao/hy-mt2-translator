/**
 * Prompt construction and streaming completion parser.
 *
 * Shared by the Node server (local mode) and the browser (static mode), so
 * the prompt text is identical wherever the app runs. Uses only web APIs:
 * fetch, TextDecoder, AbortSignal.
 *
 * Templates and sampling parameters are taken verbatim from ./README.md:
 *   - default translation template (both language variants)
 *   - "Structured Data 1" template, used for Markdown so that headings,
 *     links and code are not mangled by the translator
 *   - recommended sampling for the 1.8B/7B models
 *
 * The model has no default system prompt, so requests carry a single user
 * turn and no system message.
 */

const SAMPLING = {
  temperature: 0.7,
  top_p: 0.6,
  top_k: 20,
  repetition_penalty: 1.05,
  max_tokens: 4096,
};

function defaultTemplate(lang, text) {
  return lang.script === 'hans'
    ? `将以下文本翻译为 ${lang.zh}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`
    : `Translate the following text into ${lang.en}. Note that you should only output the translated result without any additional explanation:\n\n${text}`;
}

function markdownTemplate(lang, text) {
  return lang.script === 'hans'
    ? `# 任务目标
将下方 \`Markdown\` 中的 Markdown 格式数据翻译为 ${lang.zh}。

# 严格约束
1. 结构锁定：绝对保持原有的 Markdown 数据结构、缩进和层级完全不变。
2. 选择性翻译：仅翻译面向用户展示的可见文本内容。
3. 禁止修改：严禁翻译或更改任何代码标签、键名 (Key)、变量占位符（如 {{var}}、\${var}、%s、%d 等）或代码属性。

# 数据输入
${text}`
    : `### Task
Translate the user-facing text within the following Markdown data into ${lang.en}.

### Strict Rules
1. Structure Preservation: You MUST preserve the original Markdown data structure, nesting, hierarchy, and indentation exactly as they are.
2. Selective Translation: Translate ONLY the visible, user-facing text content.
3. Strict Non-Translation: NEVER translate or change any code tags, keys, variable placeholders (e.g. {{var}}, \${var}, %s, %d) or code attributes.

### Data Input
${text}`;
}

export function buildPrompt({ text, lang, mode }) {
  return mode === 'markdown' ? markdownTemplate(lang, text) : defaultTemplate(lang, text);
}

/**
 * Streams a completion from an OpenAI-compatible endpoint.
 * @param {{url: string, prompt: string, headers?: Record<string,string>,
 *          signal?: AbortSignal, onDelta: (t: string) => void}} opts
 * @returns {Promise<{chars: number}>} resolves when the upstream stream ends.
 */
export async function streamTranslation({ url, prompt, headers = {}, signal, onDelta }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    signal,
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      cache_prompt: false,
      ...SAMPLING,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`模型服务返回 ${res.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let out = 0;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // keep-alive or partial frame
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        out += delta.length;
        onDelta(delta);
      }
    }
  }
  return { chars: out };
}
