const fs = require('node:fs');

const FALLBACK_MODELS = [
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol (2026-09-30)
  { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: '新一代高性能通用模型', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '旗舰能力', defaultReasoningEffort: 'low', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '性能与效率平衡', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: '快速、节省额度', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: '旗舰推理能力', defaultReasoningEffort: 'low', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-sol', displayName: 'GPT-6 Sol', description: '高性能通用模型', defaultReasoningEffort: 'low', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: '快速、节省额度', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

function normalizeModel(model) {
  const slug = String(model?.slug || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(slug) || model?.visibility === 'hide') return null;
  const reasoningEfforts = (model.supported_reasoning_levels || [])
    .map((level) => String(level?.effort || '').trim())
    .filter((effort, index, values) => effort && values.indexOf(effort) === index);
  return {
    slug,
    displayName: String(model.display_name || slug).trim().slice(0, 80),
    description: String(model.description || '').trim().slice(0, 160),
    defaultReasoningEffort: String(model.default_reasoning_level || '').trim(),
    reasoningEfforts,
    priority: Number.isFinite(Number(model.priority)) ? Number(model.priority) : 999,
  };
}

function readModelCatalog(files) {
  const models = new Map();
  const hidden = new Set();
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const item of parsed.models || []) {
        const slug = String(item?.slug || '').trim();
        if (models.has(slug) || hidden.has(slug)) continue;
        if (item?.visibility === 'hide') { hidden.add(slug); continue; }
        const model = normalizeModel(item);
        if (model && !models.has(model.slug)) models.set(model.slug, model);
      }
    } catch {}
  }
  // Keep the built-in catalog as a compatibility floor.  A stale or partially
  // written Codex cache must not make a newly supported model disappear from
  // Navo's account pool (it previously caused local HTTP 404s for GPT-6 Astra).
  for (const model of FALLBACK_MODELS) if (!models.has(model.slug) && !hidden.has(model.slug)) models.set(model.slug, model);
  const values = [...models.values()].map((model, index) => ({ ...model, priority: Number.isFinite(model.priority) ? model.priority : index + 1 }));
  return values.sort((left, right) => left.priority - right.priority).map(({ priority, ...model }) => model);
}

module.exports = { FALLBACK_MODELS, readModelCatalog };
