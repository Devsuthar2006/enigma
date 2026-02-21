/**
 * Transcript Formatter for Interview Evaluation
 *
 * Extracts Q&A pairs from the full conversation log,
 * formats them cleanly, and truncates if needed.
 */

const MAX_TRANSCRIPT_CHARS = 6000;
const MAX_ANSWER_CHARS = 800;


/**
 * Format the full transcript into clean Q&A pairs.
 *
 * @param {Array} fullTranscript - Array of { role: 'assistant'|'user', content: string }
 * @returns {{ formatted: string, pairs: Array, questionCount: number }}
 */
function formatTranscript(fullTranscript) {
  if (!fullTranscript || fullTranscript.length === 0) {
    return { formatted: '', pairs: [], questionCount: 0 };
  }

  const pairs = [];
  let currentQuestion = null;
  let qIndex = 0;

  for (const msg of fullTranscript) {
    if (msg.role === 'assistant') {
      // New question — save any previous pair first
      if (currentQuestion && currentQuestion.answer) {
        pairs.push(currentQuestion);
      }
      qIndex++;
      currentQuestion = {
        number: qIndex,
        question: cleanText(msg.content),
        answer: null
      };
    } else if (msg.role === 'user' && currentQuestion) {
      // Attach answer to current question
      currentQuestion.answer = truncateText(cleanText(msg.content), MAX_ANSWER_CHARS);
    }
  }

  // Push the last pair if it has an answer
  if (currentQuestion && currentQuestion.answer) {
    pairs.push(currentQuestion);
  }

  // Build the formatted string
  let formatted = pairs.map(p =>
    `Q${p.number}: ${p.question}\nA${p.number}: ${p.answer}`
  ).join('\n\n');

  // Truncate total length if needed
  if (formatted.length > MAX_TRANSCRIPT_CHARS) {
    formatted = formatted.substring(0, MAX_TRANSCRIPT_CHARS) + '\n\n[Transcript truncated]';
  }

  return {
    formatted,
    pairs,
    questionCount: pairs.length
  };
}


/**
 * Build a structured evaluation string ready for the AI prompt.
 *
 * @param {Object} session - The interview session object
 * @returns {string} Clean transcript string
 */
function buildEvaluationTranscript(session) {
  const { formatted, questionCount } = formatTranscript(session.fullTranscript);

  if (questionCount === 0) {
    return 'No interview exchanges recorded.';
  }

  const header = [
    `Role: ${session.role}`,
    `Focus: ${session.focus}`,
    `Difficulty: ${session.difficulty}`,
    `Questions Answered: ${questionCount}`,
    '---'
  ].join('\n');

  return `${header}\n\n${formatted}`;
}


/**
 * Remove extra whitespace, newlines, and trim.
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}


/**
 * Truncate text to a maximum character length.
 */
function truncateText(text, max) {
  if (!text || text.length <= max) return text;
  return text.substring(0, max).trimEnd() + '...';
}


module.exports = {
  formatTranscript,
  buildEvaluationTranscript
};
