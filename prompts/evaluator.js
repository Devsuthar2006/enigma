/**
 * Interview Evaluation Prompt Builder
 *
 * Generates the system + user prompt pair for GPT
 * to evaluate a completed interview transcript.
 */

const { buildEvaluationTranscript } = require('./transcript');


/**
 * Build the evaluation messages array for OpenAI.
 *
 * @param {Object} session - The interview session object
 * @returns {Array} Messages array ready for openai.chat.completions.create()
 */
function buildEvaluationPrompt(session) {
  const transcript = buildEvaluationTranscript(session);

  const systemPrompt = `You are a strict, professional interview evaluator. You will receive a transcript of an interview for the role of "${session.role}" with "${session.focus}" focus at "${session.difficulty}" difficulty.

EVALUATION CRITERIA (score each 1–10):
1. Clarity — How clearly did the candidate articulate their thoughts? Were answers well-structured and easy to follow?
2. Relevance — Did the candidate answer the actual question asked? Did they stay on topic?
3. Logical Reasoning — Did the candidate demonstrate sound logic, problem-solving ability, and structured thinking?
4. Confidence — Did the candidate communicate with conviction? Were answers assertive or vague and hesitant?
5. Depth — Did the candidate go beyond surface-level answers? Did they show real understanding and experience?

SCORING GUIDE:
- 1–3: Poor. Major gaps, off-topic, or incoherent.
- 4–5: Below average. Partially relevant but lacks substance.
- 6–7: Competent. Meets expectations with minor gaps.
- 8–9: Strong. Impressive depth and clarity.
- 10: Exceptional. Could not be better.

RULES:
- Evaluate ONLY what the candidate said. Do not assume or infer.
- Be honest and fair. Do not inflate scores.
- Strengths: List 2–4 specific things the candidate did well, referencing actual answers.
- Improvement areas: List 2–4 specific, actionable things the candidate should work on.
- Overall feedback: Write 2–3 sentences summarizing the candidate's performance honestly.
- Return ONLY valid JSON. No markdown, no code fences, no commentary outside the JSON.`;

  const userPrompt = `Evaluate this interview transcript and return ONLY the JSON result.

${transcript}

Return STRICTLY this JSON format:
{
  "scores": {
    "clarity": <number 1-10>,
    "relevance": <number 1-10>,
    "logical_reasoning": <number 1-10>,
    "confidence": <number 1-10>,
    "depth": <number 1-10>
  },
  "strengths": ["<specific strength 1>", "<specific strength 2>"],
  "improvement_areas": ["<specific area 1>", "<specific area 2>"],
  "overall_feedback": "<2-3 sentence summary>"
}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
}


/**
 * Parse and validate the GPT evaluation response.
 *
 * @param {string} raw - Raw GPT response text
 * @returns {Object|null} Parsed evaluation or null if invalid
 */
function parseEvaluationResponse(raw) {
  if (!raw) return null;

  try {
    // Strip markdown code fences if GPT adds them despite instructions
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    // Validate structure
    if (!parsed.scores || typeof parsed.scores !== 'object') return null;

    const required = ['clarity', 'relevance', 'logical_reasoning', 'confidence', 'depth'];
    for (const key of required) {
      if (typeof parsed.scores[key] !== 'number') return null;
      // Clamp to 1–10
      parsed.scores[key] = Math.max(1, Math.min(10, Math.round(parsed.scores[key])));
    }

    // Compute overall score
    const values = required.map(k => parsed.scores[k]);
    parsed.scores.overall = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;

    // Ensure arrays
    if (!Array.isArray(parsed.strengths)) parsed.strengths = [];
    if (!Array.isArray(parsed.improvement_areas)) parsed.improvement_areas = [];
    if (typeof parsed.overall_feedback !== 'string') parsed.overall_feedback = '';

    return parsed;

  } catch (e) {
    console.error('Evaluation parse error:', e.message);
    return null;
  }
}


module.exports = {
  buildEvaluationPrompt,
  parseEvaluationResponse
};
