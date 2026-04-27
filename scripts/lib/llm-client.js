// ============================================================
// Shared LLM Client — OpenRouter via OpenAI-compatible API
//
// Uses the `openai` npm package with OpenRouter's baseURL.
// Requires OPENROUTER_API_KEY env var.
//
// Usage:
//   const { createClient, getModel } = require('./llm-client');
//   const client = createClient();
//   const completion = await client.chat.completions.create({
//     model: getModel(),
//     messages: [...],
//   });
// ============================================================

var _initialized = false;
var _model = null;

/**
 * Initialise provider config (idempotent).
 */
function init() {
  if (_initialized) return;

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set. Add it to your environment variables.');
  }

  _model = process.env.LLM_MODEL || 'google/gemma-4-31b-it';
  console.log('[llm] Using OpenRouter (' + _model + ')');
  _initialized = true;
}

/**
 * Create an OpenRouter LLM client using the `openai` npm package.
 */
function createClient(apiKey) {
  init();

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

/**
 * Return the model name to use.
 */
function getModel() {
  init();
  return _model;
}

/**
 * Return the provider name.
 */
function getProvider() {
  return 'openrouter';
}

/**
 * Return the API key.
 */
function getApiKey() {
  return process.env.OPENROUTER_API_KEY;
}

module.exports = {
  createClient: createClient,
  getModel: getModel,
  getProvider: getProvider,
  getApiKey: getApiKey,
};
