/**
 * Interview Conversation Engine
 * 
 * Manages interview session state, context windowing,
 * and conversation summarization for the AI Interview mode.
 */

const { buildInterviewSystemPrompt } = require('./interview');

// In-memory interview sessions
const interviewSessions = new Map();

const MAX_QUESTIONS = 8;
const SUMMARIZE_EVERY = 3; // Summarize after every 3 exchanges


/**
 * Create a new interview session
 */
function createSession(sessionId, config) {
  const session = {
    id: sessionId,
    role: config.role,
    focus: config.focus,
    difficulty: config.difficulty,
    systemPrompt: buildInterviewSystemPrompt(config),
    messages: [],               // Recent raw exchanges { role, content }
    fullTranscript: [],         // Complete log of all exchanges (never trimmed)
    conversationSummary: null,  // Compressed summary of older exchanges
    questionCount: 0,           // AI questions asked so far
    status: 'active',           // active | complete
    createdAt: Date.now()
  };

  interviewSessions.set(sessionId, session);
  return session;
}


/**
 * Get an existing session
 */
function getSession(sessionId) {
  return interviewSessions.get(sessionId) || null;
}


/**
 * Build the message payload for the OpenAI API call.
 * Uses context windowing: system prompt + summary + last 3 exchanges.
 */
function buildMessagePayload(session) {
  const messages = [];

  // 1. System prompt (always)
  messages.push({ role: 'system', content: session.systemPrompt });

  // 2. Conversation summary (if exists)
  if (session.conversationSummary) {
    messages.push({
      role: 'system',
      content: `CONVERSATION SUMMARY (earlier exchanges):\n${session.conversationSummary}`
    });
  }

  // 3. Last 3 exchanges (up to 6 messages: 3 assistant + 3 user)
  const recentMessages = session.messages.slice(-6);
  messages.push(...recentMessages);

  return messages;
}


/**
 * Append a user answer to the session
 */
function addUserMessage(session, transcript) {
  session.messages.push({ role: 'user', content: transcript });
  session.fullTranscript.push({ role: 'user', content: transcript });
}


/**
 * Append the AI's question to the session and increment counter
 */
function addAssistantMessage(session, question) {
  session.messages.push({ role: 'assistant', content: question });
  session.fullTranscript.push({ role: 'assistant', content: question });
  session.questionCount++;

  if (session.questionCount >= MAX_QUESTIONS) {
    session.status = 'complete';
  }
}


/**
 * Check if summarization is needed and return messages to summarize.
 * Summarize after every SUMMARIZE_EVERY exchanges (1 exchange = user + assistant).
 */
function shouldSummarize(session) {
  // Count exchanges (pairs of user+assistant)
  const exchangeCount = Math.floor(session.messages.length / 2);
  // We keep the last 3 exchanges raw (6 messages), summarize the rest
  return session.messages.length > 6;
}


/**
 * Build a summarization prompt from older messages
 */
function buildSummarizationPayload(session) {
  // Messages to summarize = all except the last 6
  const toSummarize = session.messages.slice(0, -6);
  if (toSummarize.length === 0) return null;

  const transcript = toSummarize.map(m => {
    const label = m.role === 'assistant' ? 'Interviewer' : 'Candidate';
    return `${label}: ${m.content}`;
  }).join('\n');

  const existingSummary = session.conversationSummary
    ? `Previous summary:\n${session.conversationSummary}\n\nNew exchanges to incorporate:\n`
    : '';

  return {
    role: 'user',
    content: `${existingSummary}Summarize the following interview exchanges into 2-3 concise lines. Capture the key topics discussed and any notable points from the candidate's answers. Do not include questions verbatim.\n\n${transcript}`
  };
}


/**
 * Apply summarization: store summary and trim old messages
 */
function applySummarization(session, summary) {
  session.conversationSummary = summary;
  // Keep only the last 6 messages (3 exchanges)
  session.messages = session.messages.slice(-6);
}


/**
 * Delete a session
 */
function deleteSession(sessionId) {
  interviewSessions.delete(sessionId);
}


/**
 * Get the full conversation transcript for report generation
 */
function getFullTranscript(session) {
  return session.fullTranscript.map((m, i) => ({
    index: i,
    role: m.role === 'assistant' ? 'interviewer' : 'candidate',
    content: m.content
  }));
}


module.exports = {
  createSession,
  getSession,
  buildMessagePayload,
  addUserMessage,
  addAssistantMessage,
  shouldSummarize,
  buildSummarizationPayload,
  applySummarization,
  getFullTranscript,
  deleteSession,
  MAX_QUESTIONS
};
