// ============================================================
// Shared LLM Client
//
// Supports multiple providers via OpenAI-compatible API:
//   1. OPENROUTER_API_KEY → OpenRouter (preferred — no daily token caps)
//   2. GROQ_API_KEY       → Groq (fallback — 100K tokens/day free tier)
//
// OpenRouter uses the `openai` npm package (correct /chat/completions path).
// Groq uses its own `groq-sdk` package.
// Both expose the same chat.completions.create() interface.
//
// Usage:
//   const { createClient, getModel } = require('./llm-client');
//   const client = createClient();
//   const completion = await client.chat.completions.create({
//     model: getModel(),
//     messages: [...],
//   });
// ============================================================

var _provider = null;
var _model = null;

/**
 * Detect which provider is available and return the appropriate config.
 */
function detectProvider() {
  if (_provider) return _provider;

  if (process.env.OPENROUTER_API_KEY) {
    _provider = 'openrouter';
    // Default model — override with LLM_MODEL env var
    _model = process.env.LLM_MODEL || 'google/gemma-4-31b-it';
    console.log('[llm] Using OpenRouter (' + _model + ')');
    return _provider;
  }

  if (process.env.GROQ_API_KEY) {
    _provider = 'groq';
    _model = 'llama-3.3-70b-versatile';
    console.log('[llm] Using Groq (' + _model + ')');
    return _provider;
  }

  throw new Error('No LLM API key configured. Set OPENROUTER_API_KEY or GROQ_API_KEY.');
}

/**
 * Create an LLM client. OpenRouter uses the `openai` package (which sends
 * requests to /chat/completions). Groq uses `groq-sdk`. Both share the
 * same chat.completions.create() interface, so callers don't change.
 *
 * NOTE: The groq-sdk hardcodes /openai/v1/chat/completions as its path,
 * which is wrong for OpenRouter (needs /chat/completions). That's why we
 * use the openai package for OpenRouter instead.
 */
function createClient(apiKey) {
  var provider = detectProvider();

  if (provider === 'openrouter') {
    // OpenRouter uses the standard OpenAI-compatible API at /api/v1.
    var OpenAI = require('openai');
    return new OpenAI({
      apiKey: apiKey || process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://asx-calendar-api.vercel.app',
        'X-Title': 'ASX Calendar API',
      },
    });
  }

  // Default: Groq
  var Groq = require('groq-sdk');
  return new Groq({ apiKey: apiKey || process.env.GROQ_API_KEY });
}

/**
 * Return the model name to use.
 */
function getModel() {
  detectProvider();
  return _model;
}

/**
 * Return the provider name ('openrouter' or 'groq').
 */
function getProvider() {
  return detectProvider();
}

/**
 * Return the API key to pass to functions that need it.
 */
function getApiKey() {
  detectProvider();
  if (_provider === 'openrouter') return process.env.OPENROUTER_API_KEY;
  return process.env.GROQ_API_KEY;
}

/**
 * Check if the current provider has daily token limits that require
 * budget-aware abort logic. OpenRouter does not; Groq free tier does.
 */
function hasDailyTokenLimit() {
  detectProvider();
  return _provider === 'groq';
}

module.exports = {
  createClient: createClient,
  getModel: getModel,
  getProvider: getProvider,
  getApiKey: getApiKey,
  hasDailyTokenLimit: hasDailyTokenLimit,
};
