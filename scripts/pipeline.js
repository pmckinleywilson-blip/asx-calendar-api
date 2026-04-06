// ============================================================
// Pipeline Orchestrator
// Runs detect.js, verify.js, then notify.js in sequence.
// Captures output and exit codes. Suitable for GitHub Actions.
//
// Required env vars: GROQ_API_KEY, DATABASE_URL, RESEND_API_KEY, INVITE_FROM_EMAIL
// Usage: node scripts/pipeline.js
// ============================================================

const { spawn } = require('child_process');
const path = require('path');

// ---------------------------------------------------------------------------
// Run a child script and stream its output to stdout/stderr
// ---------------------------------------------------------------------------

function runScript(scriptPath) {
  return new Promise(function (resolve, reject) {
    console.log('[pipeline] Running: node ' + scriptPath);
    console.log('[pipeline] ' + '-'.repeat(60) + '\n');

    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd: path.resolve(__dirname, '..'),
    });

    child.stdout.on('data', function (data) {
      process.stdout.write(data);
    });

    child.stderr.on('data', function (data) {
      process.stderr.write(data);
    });

    child.on('error', function (err) {
      reject(err);
    });

    child.on('close', function (code) {
      console.log('\n[pipeline] ' + path.basename(scriptPath) + ' exited with code ' + code);
      resolve(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log('##########################################################');
  console.log('#  ASX Calendar API — Event Detection & Notification     #');
  console.log('#  Pipeline Orchestrator                                  #');
  console.log('##########################################################');
  console.log('Started: ' + new Date().toISOString());
  console.log('');

  // Validate minimum required env vars
  const requiredVars = ['GROQ_API_KEY', 'DATABASE_URL'];
  const missing = requiredVars.filter(function (v) { return !process.env[v]; });
  if (missing.length > 0) {
    console.error('[pipeline] FATAL: Missing required environment variables: ' + missing.join(', '));
    process.exit(1);
  }

  // Step 1: Detection (ASX announcements)
  console.log('[pipeline] ==> Step 1: Event Detection (ASX Announcements)');
  console.log('');

  const detectScript = path.resolve(__dirname, 'detect.js');
  const detectCode = await runScript(detectScript);

  if (detectCode !== 0) {
    console.error('[pipeline] Detection script failed with exit code ' + detectCode);
    // Continue to verification anyway — IR pages are independent
    console.log('[pipeline] Continuing to verification step despite detection failure...\n');
  }

  // Step 2: IR Page Verification (highest-priority source)
  console.log('\n[pipeline] ==> Step 2: IR Page Verification');
  console.log('');

  const verifyScript = path.resolve(__dirname, 'verify.js');
  const verifyCode = await runScript(verifyScript);

  if (verifyCode !== 0) {
    console.error('[pipeline] Verification script failed with exit code ' + verifyCode);
    console.log('[pipeline] Continuing to notification step despite verification failure...\n');
  }

  // Step 3: Notification
  // Only run if RESEND_API_KEY is available
  if (process.env.RESEND_API_KEY) {
    console.log('\n[pipeline] ==> Step 3: Event Notification');
    console.log('');

    const notifyScript = path.resolve(__dirname, 'notify.js');
    const notifyCode = await runScript(notifyScript);

    if (notifyCode !== 0) {
      console.error('[pipeline] Notification script failed with exit code ' + notifyCode);
    }
  } else {
    console.log('\n[pipeline] ==> Step 3: Skipped (RESEND_API_KEY not set)');
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n##########################################################');
  console.log('#  Pipeline Complete                                      #');
  console.log('##########################################################');
  console.log('  Total duration: ' + elapsed + 's');
  console.log('  Finished: ' + new Date().toISOString());
  console.log('##########################################################\n');

  // Exit with detection exit code (most critical step)
  if (detectCode !== 0) {
    process.exit(detectCode);
  }
}

main().catch(function (err) {
  console.error('[pipeline] Fatal error:', err);
  process.exit(1);
});
