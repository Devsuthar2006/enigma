# DebAItor
**AI-Assisted Discussion & Debate Evaluation Platform**

### 🚀 [Live Demo](https://enigma-kohl-five.vercel.app)

## Problem Statement
Evaluating discussions and debates is often subjective, biased, and inconsistent. In educational and professional settings, feedback typically focuses on "winning" or volume rather than logical structure, clarity, and relevance.

## Solution Overview
DebAItor is a real-time, AI-powered platform that objectively evaluates debate arguments and conducts realistic AI mock interviews. It removes human bias by focusing strictly on logical reasoning, clarity, and relevance, ensuring fair and constructive feedback for every participant rather than just declaring a "winner" based on opinion.

## Key Features
*   **Four Unique Discussion Modes**:
    *   ⚔️ **Debate**: Competitive scoring with rankings and winner badges.
    *   📚 **Classroom**: Focus on learning, skill meters, and constructive feedback.
    *   🎙️ **Panel Discussion**: Emphasizes balanced participation and moderator insights.
    *   💼 **Meeting**: Executive summaries, actionable insights, and key takeaways.
*   **🤖 AI Interview Mode (NEW!)**:
    *   **Immersive Voice Experience**: Features OpenAI TTS (with ElevenLabs fallback) for a natural, human-like interviewer voice.
    *   **Real-time Speech Recognition**: Uses Whisper for high-accuracy and fast audio transcription.
    *   **Dynamic Conversations**: The AI engine asks follow-up questions organically based on your answers.
    *   **Advanced Evaluation**: Comprehensive post-interview reports with animated score wheels, breaking down Communication, Content, Technical/Role Fit, logic, and actionable areas of improvement.
*   **Live Room Creation**: Instant session setup with unique room codes.
*   **Seamless Joining**: Participants join instantly via QR code on any device.
*   **Structured AI Evaluation**: Arguments are scored on:
    *   **Clarity**: How understandable the point is.
    *   **Relevance**: Staying on topic.
    *   **Logic**: Coherence and reasoning structure.
    *   **Emotional Bias**: Objectivity vs. emotional appeal.
*   **Persistent Sessions**: Robust Firestore data handling ensures debates survive refreshes.

## How It Works

### Group Debates
1.  **Create Room**: Host starts a session and shares the QR code.
2.  **Join**: Participants scan to enter the debate lobby.
3.  **Debate**: Participants record audio arguments in turn-based rounds.
4.  **Results**: View live scores and download a comprehensive report.

### AI Interviews
1.  **Configure**: Set your role (e.g., "Software Engineer"), focus area, and difficulty.
2.  **Speak**: Engage in a natural verbal conversation with the AI interviewer.
3.  **Analyze**: Get a detailed breakdown of your performance with constructive feedback.

## Tech Stack
*   **Frontend**: HTML5, CSS3, Vanilla JavaScript
*   **Backend**: Node.js, Express
*   **Database**: Firebase Firestore
*   **AI & Processing**: OpenAI GPT-4, Whisper (Speech-to-Text), OpenAI TTS / ElevenLabs
*   **Deployment**: Vercel

## Why This Matters
*   **Promotes Fairness**: Evaluating arguments on merit, not speaker charisma.
*   **Educational Value**: Teaches structured thinking and articulate speaking.
*   **Career Prep**: Provides a stress-free, accurate environment for interview practice without human judgments.

## Future Scope
*   **Multi-Language Support**: Breaking language barriers in debates and interviews.
*   **Team Mode**: Supporting 2v2 or 3v3 structured debates.
*   **Event Integration**: Tailoring the platform for large-scale use in conference halls and formal debate competitions.

## Hackathon Note
Built as a high-impact submission for the hackathon.
