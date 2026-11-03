/**
 * Keyword heuristic for "this candidate or component probably runs on a
 * pretrained model" (docs/PLAN.md §7.4 "Model weights"). Used in two places:
 *
 * - `core/decompose.ts` plans a `hf_models` search for a component whose
 *   name, description or keywords sound like ML (purpose `search`);
 * - `rw_evaluate` raises the `model_weights_unverified` flag for a
 *   github/npm/pypi/mcp candidate whose name or description sounds like ML
 *   and that came without a `weights_ref` (purpose `weights`).
 *
 * The purposes differ in two ways: `llm`, `llms` and `gpt` mean a remote API call
 * as often as local weights (an LLM gateway or an OpenAI client loads none), so
 * they only count for `search`, where a wasted model search costs little. And
 * `embedding(s)` is a feature word that a vector store or a database mentions
 * without loading a model, so for `weights` it is a weak term (trusted in a name
 * or keyword list only), while `search` keeps it as a strong one.
 *
 * It is deliberately a hint, not a classifier: a false positive costs one
 * warning, a false negative is the miss this exists to reduce. Two strengths
 * keep the noise down: `strong` terms name model tooling or a model family and
 * are safe to match in free-form text; `weak` terms (a task such as "speech"
 * or "detector") are only trusted in a name or a keyword list, where they are
 * a deliberate choice. Pure and deterministic.
 */

/** Terms that name model tooling, formats or families. Latin terms match whole words, others as substrings. */
const STRONG_TERMS: readonly string[] = [
  'onnx',
  'onnxruntime',
  'safetensors',
  'gguf',
  'pytorch',
  'torch',
  'tensorflow',
  'tflite',
  'transformers',
  'huggingface',
  'hugging face',
  'llm',
  'llms',
  'embedding',
  'embeddings',
  'whisper',
  'bert',
  'gpt',
  'llama',
  'llama.cpp',
  'whisper.cpp',
  'ggml',
  'diffusion',
  'pretrained',
  'pre-trained',
  'fine-tuned',
  'fine-tuning',
  'model weights',
  'neural network',
  'machine learning',
  'deep learning',
  'speech recognition',
  'speech-to-text',
  'text-to-speech',
  'voice activity',
  'end-of-utterance',
  'turn detection',
  'turn-detection',
  '딥러닝',
  '머신러닝',
  '신경망',
  '음성 인식',
  '음성인식',
  '음성 합성',
  '임베딩',
  '언어 모델',
  '언어모델',
];

/** Strong terms that usually name a remote API, not local weights; ignored for the `weights` purpose. */
const REMOTE_API_TERMS: ReadonlySet<string> = new Set(['llm', 'llms', 'gpt']);

/** Strong terms that count only as weak ones for the `weights` purpose: a description that mentions them proves nothing. */
const FEATURE_TERMS: ReadonlySet<string> = new Set(['embedding', 'embeddings', '임베딩']);

/** Task words: only meaningful in a name or a keyword list. */
const WEAK_TERMS: readonly string[] = [
  'detector',
  'detection',
  'classifier',
  'classification',
  'recognition',
  'segmentation',
  'sentiment',
  'translation',
  'tts',
  'stt',
  'asr',
  'vad',
  'ocr',
  'speech',
  'voice',
  'neural',
  'inference',
  '음성',
  '번역',
  '감정 분석',
  '이미지 분류',
];

/** `token` without trailing dots and hyphens; a plain scan, because a regex over a long run of them backtracks quadratically. */
function trimTrailingDotsAndHyphens(token: string): string {
  let end = token.length;
  while (end > 0 && (token[end - 1] === '.' || token[end - 1] === '-')) end--;
  return token.slice(0, end);
}

function normalize(text: string): string {
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}+.-]+/gu, ' ').split(' ');
  // Only a run that is followed by a space is dropped, so the last token keeps its trailing dots and hyphens.
  const last = tokens.length - 1;
  return ` ${tokens.map((t, i) => (i < last ? trimTrailingDotsAndHyphens(t) : t)).join(' ')} `;
}

function matches(normalized: string, term: string): boolean {
  // Terms with letters outside ASCII (Korean) attach particles to the stem: match them as substrings.
  if (/[^\x00-\x7f]/.test(term)) return normalized.includes(term);
  const t = term.replace(/-/g, ' ');
  return normalized.includes(` ${t} `) || normalized.includes(` ${term} `);
}

/** Terms from `list` found in `text` (lowercase, deduplicated, in list order). */
function found(text: string, list: readonly string[]): string[] {
  const normalized = normalize(text);
  // Also match the hyphenated spelling against a space-separated text and vice versa.
  const spaced = normalized.replace(/-/g, ' ');
  return list.filter((term) => matches(normalized, term) || matches(spaced, term));
}

/** What the answer is for: planning a model search (`search`) or suspecting local weights in a candidate (`weights`). */
export type MlPurpose = 'search' | 'weights';

/**
 * ML terms found in `text`.
 * `strength: 'strong'` looks only for model tooling and families (use for
 * descriptions and READMEs); `'any'` adds task words (use for names and keyword lists).
 * `purpose: 'weights'` leaves out the remote-API words (`llm`, `llms`, `gpt`) and
 * counts `embedding(s)` as a weak term (found with `'any'`, not with `'strong'`).
 */
export function mlTermsIn(text: string, strength: 'strong' | 'any', purpose: MlPurpose = 'search'): string[] {
  if (purpose === 'search') return found(text, strength === 'strong' ? STRONG_TERMS : [...STRONG_TERMS, ...WEAK_TERMS]);
  const local = STRONG_TERMS.filter((t) => !REMOTE_API_TERMS.has(t));
  return found(text, strength === 'strong' ? local.filter((t) => !FEATURE_TERMS.has(t)) : [...local, ...WEAK_TERMS]);
}

/** Convenience: whether `mlTermsIn` finds anything. */
export function soundsLikeMl(text: string, strength: 'strong' | 'any', purpose: MlPurpose = 'search'): boolean {
  return mlTermsIn(text, strength, purpose).length > 0;
}
