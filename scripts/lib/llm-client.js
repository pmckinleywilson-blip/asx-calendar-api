// ============================================================
// Shared LLM Client
//
// Supports multiple providers via OpenAI-compatible API:
//   1. OPENROUTER_API_KEY → OpenRouter (preferred — no daily token caps)
//   2. GROQ_API_KEY       → Groq (fallback — 100K tokens/day free tier)
//
// OpenRouter free models (no cost):
//   - meta-llama/llama-3.1-8b-instruct:free
//   - google/gemma-2-9b-it:free
//   - qwen/qwen-2.5-7b-instruct:free
//
// OpenRouter paid models (cheap, ~$0.10-0.30/M tokens):
//   - meta-llama/llama-3.3-70b-instruct
//   - google/gemini-flash-1.5
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
    _model = process.env.LLM_MODEL || 'google/gemma-4-31b-it:free';
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
 * Create an LLM client. Both Groq SDK and OpenAI SDK share the same
 * chat.completions.create() interface, so callers don't need to change.
 */
function createClient(apiKey) {
  var provider = detectProvider();

  if (provider === 'openrouter') {
    // OpenRouter uses the OpenAI-compatible API.
    // The groq-sdk package also supports custom baseURL, so we can reuse it.
    var Groq = require('groq-sdk');
    return new Groq({
      apiKey: apiKey || process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  // Default: Groq
  var Groq2 = require('groq-sdk');
  return new Groq2({ apiKey: apiKey || process.env.GROQ_API_KEY });
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
