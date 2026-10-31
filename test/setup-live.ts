/**
 * Magpie DeepSeek defaults for the local live suite.
 * Never inject on CI / mock-fixture mode so GitHub Actions stays offline.
 */
const onCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
const allowMock = process.env.DS_AGENT_ALLOW_MOCK_FIXTURE === '1'
const hasLiveKey = Boolean(
  process.env.DS_AGENT_API_KEY
  || process.env.DEEPSEEK_API_KEY
  || process.env.OPENAI_API_KEY,
)

if (!onCi && !allowMock) {
  if (!process.env.DS_AGENT_API_BASE) process.env.DS_AGENT_API_BASE = 'http://127.0.0.1:3425/v1'
  if (!process.env.DS_AGENT_API_KEY) process.env.DS_AGENT_API_KEY = 'magpie'
  if (!process.env.DS_AGENT_API_MODEL) process.env.DS_AGENT_API_MODEL = 'workbuddy/deepseek-v4.1-flash'
} else if (onCi && hasLiveKey && !allowMock) {
  // Opt-in live CI job may already export keys; do not invent Magpie defaults.
}
