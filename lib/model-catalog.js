const fs = require('node:fs');

const FALLBACK_MODELS = [
  { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '旗舰能力', defaultReasoningEffort: 'low', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: '性能与效率平衡', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: '快速、节省额度', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
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
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const item of parsed.models || []) {
        const model = normalizeModel(item);
        if (model && !models.has(model.slug)) models.set(model.slug, model);
      }
    } catch {}
  }
  const values = models.size ? [...models.values()] : FALLBACK_MODELS.map((model, index) => ({ ...model, priority: index + 1 }));
  return values.sort((left, right) => left.priority - right.priority).map(({ priority, ...model }) => model);
}

module.exports = { FALLBACK_MODELS, readModelCatalog };
