/**
 * DebAItor - Main Server (Turn-Based Version)
 * 
 * A turn-based debate app where:
 * - Host controls the flow
 * - Each player gets 30 seconds per turn
 * - Multiple rounds supported
 * - AI evaluates all responses at the end
 * 
 * Storage: Firebase Firestore (with in-memory fallback)
 */

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const OpenAI = require('openai');

// Firebase imports
const firebaseHelper = require('./firebase');
const { 
  db: firestore, 
  createRoom: fbCreateRoom, 
  getRoom: fbGetRoom, 
  updateRoom: fbUpdateRoom,
  addParticipant: fbAddParticipant,
  addArgument: fbAddArgument,
  saveReport: fbSaveReport,
  getReport: fbGetReport
} = firebaseHelper;

const app = express();
const PORT = process.env.PORT || 3000;

// Storage mode
const USE_FIRESTORE = !!firestore;
console.log(USE_FIRESTORE ? '🔥 Using Firebase Firestore for persistence' : '💾 Using in-memory storage (no persistence)');

// Check for OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_MOCK_AI = !OPENAI_API_KEY || OPENAI_API_KEY.startsWith('sk_your');

if (USE_MOCK_AI) {
  console.warn('\n⚠️  WARNING: No valid OpenAI API key found!');
  console.warn('   Using MOCK responses. Add OPENAI_API_KEY to .env for real AI.\n');
} else {
  console.log('✅ OpenAI API key detected - Real AI enabled!\n');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// In-memory storage fallback
const memoryRooms = new Map();

// Initialize OpenAI client
let openai = null;
if (!USE_MOCK_AI) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
}

// Generate room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ============ DISCUSSION STATES ============
const STATES = {
  WAITING: 'waiting',
  COLLECTING: 'collecting',
  EVALUATING: 'evaluating',
  RESULTS: 'results'
};

// ============ STORAGE HELPERS ============
// Firestore is the single source of truth when enabled
// Memory cache is used for performance optimization

/**
 * Get room from storage (Firestore first, then memory fallback)
 */
async function getRoom(roomCode) {
  // Check memory cache first for performance
  if (memoryRooms.has(roomCode)) {
    return memoryRooms.get(roomCode);
  }
  
  // If Firestore enabled, fetch and cache
  if (USE_FIRESTORE) {
    const room = await fbGetRoom(roomCode);
    if (room) {
      // Cache in memory for subsequent requests
      memoryRooms.set(roomCode, room);
    }
    return room;
  }
  
  return null;
}

/**
 * Save room to storage
 */
async function saveRoom(roomCode, roomData) {
  // Always save to memory cache first
  memoryRooms.set(roomCode, roomData);
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    await fbCreateRoom(roomCode, roomData);
  }
}

/**
 * Update room in storage
 */
async function updateRoomData(roomCode, updates) {
  // Update memory cache
  const room = memoryRooms.get(roomCode);
  if (room) {
    Object.assign(room, updates);
  }
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    await fbUpdateRoom(roomCode, updates);
  }
}

/**
 * Add participant to storage
 */
async function addParticipantToRoom(roomCode, participantId, participantData) {
  // Update memory cache
  let room = memoryRooms.get(roomCode);
  
  // If room not in cache, fetch it first
  if (!room && USE_FIRESTORE) {
    room = await fbGetRoom(roomCode);
    if (room) {
      memoryRooms.set(roomCode, room);
    }
  }
  
  if (room) {
    room.participants.set(participantId, {
      ...participantData,
      responses: [],
      joinedAt: Date.now()
    });
    room.turnOrder.push(participantId);
  }
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    await fbAddParticipant(roomCode, participantId, participantData);
    // Update turnOrder in Firestore
    if (room) {
      await fbUpdateRoom(roomCode, { turnOrder: room.turnOrder });
    }
  }
}

/**
 * Add argument to storage
 */
async function addArgumentToRoom(roomCode, participantId, argumentData) {
  // Get room from cache or Firestore
  let room = memoryRooms.get(roomCode);
  if (!room && USE_FIRESTORE) {
    room = await fbGetRoom(roomCode);
    if (room) {
      memoryRooms.set(roomCode, room);
    }
  }
  
  // Update memory cache
  if (room) {
    const participant = room.participants.get(participantId);
    if (participant) {
      if (!participant.responses) participant.responses = [];
      participant.responses.push(argumentData);
    }
  }
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    const argId = uuidv4();
    await fbAddArgument(roomCode, argId, {
      participantId,
      text: argumentData.transcript,
      round: argumentData.round,
      scores: argumentData.scores
    });
  }
}

// ============ API ROUTES ============

/**
 * Create a new room
 */
app.post('/api/rooms', async (req, res) => {
  const { topic } = req.body;
  
  if (!topic || topic.trim().length === 0) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  const roomCode = generateRoomCode();
  const hostId = uuidv4();

  const roomData = {
    topic: topic.trim(),
    hostId,
    participants: new Map(),
    currentTurn: null,
    turnOrder: [],
    currentRound: 0,
    status: STATES.WAITING,
    locked: false,
    createdAt: Date.now()
  };

  // Save to storage
  await saveRoom(roomCode, roomData);

  console.log(`Room created: ${roomCode} - "${topic}" (Host: ${hostId})`);
  res.json({ roomCode, topic, hostId });
});

/**
 * Helper: Verify host authorization
 */
function verifyHost(room, hostId) {
  return room && room.hostId === hostId;
}

/**
 * Get room info
 */
app.get('/api/rooms/:code', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const participants = Array.from(room.participants.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    responses: data.responses?.length || 0,
    isCurrentTurn: room.currentTurn === id
  }));

  res.json({
    roomCode,
    topic: room.topic,
    status: room.status,
    locked: room.locked,
    currentRound: room.currentRound,
    currentTurn: room.currentTurn,
    currentTurnName: room.currentTurn ? room.participants.get(room.currentTurn)?.name : null,
    participants,
    turnOrder: room.turnOrder
  });
});

/**
 * Generate QR code
 */
app.get('/api/rooms/:code/qr', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const joinUrl = `${baseUrl}/join.html?code=${roomCode}`;
    
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.json({ qrCode: qrDataUrl, joinUrl });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

/**
 * Join a room
 */
app.post('/api/rooms/:code/join', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { name } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status === 'ended' || room.status === STATES.RESULTS) {
    return res.status(400).json({ error: 'Debate has ended' });
  }

  if (room.locked) {
    return res.status(403).json({ error: 'Room is locked. No new participants allowed.' });
  }

  const participantId = uuidv4();
  const participantData = { name: name.trim() };

  // Add to storage (this also updates turnOrder)
  await addParticipantToRoom(roomCode, participantId, participantData);

  console.log(`${name} joined room ${roomCode}`);

  res.json({ 
    participantId, 
    name: name.trim(),
    topic: room.topic,
    roomCode 
  });
});

/**
 * HOST: Lock/Unlock room
 */
app.post('/api/rooms/:code/lock', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { hostId, lock } = req.body;
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!verifyHost(room, hostId)) {
    return res.status(403).json({ error: 'Unauthorized. Host access required.' });
  }

  const locked = lock !== false;
  await updateRoomData(roomCode, { locked });
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    memoryRooms.get(roomCode).locked = locked;
  }

  console.log(`Room ${roomCode} ${locked ? 'LOCKED' : 'UNLOCKED'} by host`);

  res.json({ success: true, locked });
});

/**
 * HOST: Remove a participant
 */
app.post('/api/rooms/:code/remove-participant', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { hostId, participantId } = req.body;
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!verifyHost(room, hostId)) {
    return res.status(403).json({ error: 'Unauthorized. Host access required.' });
  }

  const participant = room.participants.get(participantId);
  if (!participant) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  const name = participant.name;
  
  // Update in memory
  if (memoryRooms.has(roomCode)) {
    const memRoom = memoryRooms.get(roomCode);
    memRoom.participants.delete(participantId);
    memRoom.turnOrder = memRoom.turnOrder.filter(id => id !== participantId);
    
    if (memRoom.currentTurn === participantId) {
      memRoom.currentTurn = memRoom.turnOrder.length > 0 ? memRoom.turnOrder[0] : null;
    }
  }

  // Update Firestore
  if (USE_FIRESTORE) {
    const newTurnOrder = room.turnOrder.filter(id => id !== participantId);
    const newCurrentTurn = room.currentTurn === participantId 
      ? (newTurnOrder.length > 0 ? newTurnOrder[0] : null) 
      : room.currentTurn;
    
    await updateRoomData(roomCode, { 
      turnOrder: newTurnOrder,
      currentTurn: newCurrentTurn
    });
  }

  console.log(`Host removed ${name} from room ${roomCode}`);

  res.json({ success: true, removed: name });
});

/**
 * HOST: Start the debate
 */
app.post('/api/rooms/:code/start', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.turnOrder.length === 0) {
    return res.status(400).json({ error: 'No participants yet' });
  }

  const currentTurn = room.turnOrder[0];
  const updates = {
    status: STATES.COLLECTING,
    currentRound: 1,
    currentTurn
  };

  await updateRoomData(roomCode, updates);
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    Object.assign(memoryRooms.get(roomCode), updates);
  }

  const currentName = room.participants.get(currentTurn)?.name;
  console.log(`Debate started in ${roomCode}. Round 1, ${currentName}'s turn`);

  res.json({ 
    success: true, 
    message: 'Debate started',
    currentTurn,
    currentTurnName: currentName,
    round: 1
  });
});

/**
 * HOST: Move to next turn
 */
app.post('/api/rooms/:code/next-turn', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.COLLECTING) {
    return res.status(400).json({ error: 'Debate not active. Current state: ' + room.status });
  }

  const currentIndex = room.turnOrder.indexOf(room.currentTurn);
  const nextIndex = currentIndex + 1;

  let currentRound = room.currentRound;
  let currentTurn;

  if (nextIndex >= room.turnOrder.length) {
    currentRound++;
    currentTurn = room.turnOrder[0];
    console.log(`Round ${currentRound} started in ${roomCode}`);
  } else {
    currentTurn = room.turnOrder[nextIndex];
  }

  const updates = { currentRound, currentTurn };
  await updateRoomData(roomCode, updates);
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    Object.assign(memoryRooms.get(roomCode), updates);
  }

  const currentName = room.participants.get(currentTurn)?.name;
  console.log(`Next turn: ${currentName}`);

  res.json({ 
    success: true,
    currentTurn,
    currentTurnName: currentName,
    round: currentRound
  });
});

/**
 * HOST: End debate and calculate results
 */
app.post('/api/rooms/:code/end', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Transition to evaluating state
  await updateRoomData(roomCode, { status: STATES.EVALUATING, currentTurn: null });

  console.log(`Debate ended in ${roomCode}. Evaluating submissions...`);

  // Calculate results
  const results = [];

  for (const [id, data] of room.participants) {
    const argumentsCount = data.responses?.length || 0;
    const participationStatus = argumentsCount > 0 ? 'active' : 'silent';
    
    if (argumentsCount === 0) {
      results.push({
        id,
        name: data.name,
        argumentsSubmitted: 0,
        participationStatus: 'silent',
        totalResponses: 0,
        averageScore: 0,
        responses: []
      });
      continue;
    }

    const avgLogic = data.responses.reduce((sum, r) => sum + (r.scores?.logic || 5), 0) / argumentsCount;
    const avgClarity = data.responses.reduce((sum, r) => sum + (r.scores?.clarity || 5), 0) / argumentsCount;
    const avgRelevance = data.responses.reduce((sum, r) => sum + (r.scores?.relevance || 5), 0) / argumentsCount;
    const avgEmotionalBias = data.responses.reduce((sum, r) => sum + (r.scores?.emotionalBias || 5), 0) / argumentsCount;
    
    const averageScore = (avgLogic * 0.35) + (avgClarity * 0.25) + (avgRelevance * 0.30) + ((10 - avgEmotionalBias) * 0.10);
    const lastSummary = data.responses.length > 0 ? data.responses[data.responses.length - 1].scores?.summary : null;

    results.push({
      id,
      name: data.name,
      argumentsSubmitted: argumentsCount,
      participationStatus,
      totalResponses: argumentsCount,
      averageScores: {
        logic: Math.round(avgLogic * 10) / 10,
        clarity: Math.round(avgClarity * 10) / 10,
        relevance: Math.round(avgRelevance * 10) / 10,
        emotionalBias: Math.round(avgEmotionalBias * 10) / 10
      },
      averageScore: Math.round(averageScore * 10) / 10,
      summary: lastSummary,
      responses: data.responses
    });
  }

  results.sort((a, b) => b.averageScore - a.averageScore);
  results.forEach((r, i) => { r.rank = i + 1; });

  // Save report to Firestore
  if (USE_FIRESTORE) {
    await fbSaveReport(roomCode, {
      evaluationScores: results.map(r => ({ id: r.id, score: r.averageScore })),
      summaries: results.map(r => ({ id: r.id, name: r.name, summary: r.summary })),
      overallSummary: `Winner: ${results[0]?.name || 'N/A'}`,
      results
    });
  }

  // Transition to results state
  await updateRoomData(roomCode, { status: STATES.RESULTS });
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    memoryRooms.get(roomCode).status = STATES.RESULTS;
  }

  console.log(`Results ready for ${roomCode}`);

  res.json({ roomCode, topic: room.topic, results });
});

/**
 * Submit audio response
 */
app.post('/api/rooms/:code/submit', upload.single('audio'), async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { participantId } = req.body;

  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.COLLECTING) {
    return res.status(400).json({ error: 'Debate not in progress' });
  }

  if (room.currentTurn !== participantId) {
    return res.status(400).json({ error: 'Not your turn' });
  }

  const participant = room.participants.get(participantId);

  if (!participant) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required' });
  }

  try {
    let transcript;
    let evaluation;

    if (USE_MOCK_AI) {
      console.log(`[MOCK] Processing for ${participant.name}...`);
      transcript = getMockTranscript();
      evaluation = getMockEvaluation();
    } else {
      console.log(`Transcribing audio for ${participant.name}...`);
      
      const audioFile = fs.createReadStream(req.file.path);
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'en'
      });

      transcript = transcription.text;
      console.log(`Transcript: "${transcript.substring(0, 50)}..."`);

      console.log(`Evaluating response...`);
      evaluation = await evaluateResponse(room.topic, transcript);
    }

    const argumentData = {
      round: room.currentRound,
      transcript,
      scores: evaluation,
      submittedAt: Date.now()
    };

    // Store the response
    await addArgumentToRoom(roomCode, participantId, argumentData);

    // Clean up audio file
    fs.unlink(req.file.path, () => {});

    console.log(`${participant.name} submitted Round ${room.currentRound}: Score ${evaluation.finalScore}`);

    res.json({
      success: true,
      transcript,
      scores: evaluation,
      round: room.currentRound
    });

  } catch (error) {
    console.error('Submission error:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Failed to process', details: error.message });
  }
});

/**
 * Get current turn status (for participant polling)
 */
app.get('/api/rooms/:code/turn-status', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { participantId } = req.query;
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const isMyTurn = room.currentTurn === participantId;
  const currentTurnName = room.currentTurn ? room.participants.get(room.currentTurn)?.name : null;

  res.json({
    status: room.status,
    round: room.currentRound,
    isMyTurn,
    currentTurnName,
    currentTurn: room.currentTurn
  });
});

/**
 * Get results (only when debate ended)
 */
app.get('/api/rooms/:code/results', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.RESULTS && room.status !== 'ended') {
    return res.status(400).json({ error: 'Debate has not ended yet' });
  }

  // Try to get from Firestore report first
  if (USE_FIRESTORE) {
    const report = await fbGetReport(roomCode);
    if (report && report.results) {
      return res.json({ roomCode, topic: room.topic, results: report.results });
    }
  }

  // Calculate results from participants
  const results = [];

  for (const [id, data] of room.participants) {
    if (!data.responses || data.responses.length === 0) {
      results.push({ id, name: data.name, totalResponses: 0, averageScore: 0, responses: [] });
      continue;
    }

    const avgLogic = data.responses.reduce((sum, r) => sum + (r.scores?.logic || 0), 0) / data.responses.length;
    const avgClarity = data.responses.reduce((sum, r) => sum + (r.scores?.clarity || 0), 0) / data.responses.length;
    const avgRelevance = data.responses.reduce((sum, r) => sum + (r.scores?.relevance || 0), 0) / data.responses.length;
    const avgEmotionalBias = data.responses.reduce((sum, r) => sum + (r.scores?.emotionalBias || 0), 0) / data.responses.length;
    
    const averageScore = (avgLogic * 0.35 + avgClarity * 0.25 + avgRelevance * 0.3 + (10 - avgEmotionalBias) * 0.1);

    results.push({
      id,
      name: data.name,
      totalResponses: data.responses.length,
      averageScores: {
        logic: Math.round(avgLogic * 10) / 10,
        clarity: Math.round(avgClarity * 10) / 10,
        relevance: Math.round(avgRelevance * 10) / 10,
        emotionalBias: Math.round(avgEmotionalBias * 10) / 10
      },
      averageScore: Math.round(averageScore * 10) / 10,
      responses: data.responses
    });
  }

  results.sort((a, b) => b.averageScore - a.averageScore);
  results.forEach((r, i) => { r.rank = i + 1; });

  res.json({ roomCode, topic: room.topic, results });
});

/**
 * Export discussion report (text format)
 */
app.get('/api/rooms/:code/report', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const format = req.query.format || 'text';
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.RESULTS && room.status !== 'ended') {
    return res.status(400).json({ error: 'Debate has not ended yet' });
  }

  // Get results
  let results = [];
  
  if (USE_FIRESTORE) {
    const report = await fbGetReport(roomCode);
    if (report && report.results) {
      results = report.results;
    }
  }

  if (results.length === 0) {
    for (const [id, data] of room.participants) {
      if (!data.responses || data.responses.length === 0) {
        results.push({ id, name: data.name, totalResponses: 0, averageScore: 0, responses: [] });
        continue;
      }

      const avgLogic = data.responses.reduce((sum, r) => sum + (r.scores?.logic || 0), 0) / data.responses.length;
      const avgClarity = data.responses.reduce((sum, r) => sum + (r.scores?.clarity || 0), 0) / data.responses.length;
      const avgRelevance = data.responses.reduce((sum, r) => sum + (r.scores?.relevance || 0), 0) / data.responses.length;
      const avgEmotionalBias = data.responses.reduce((sum, r) => sum + (r.scores?.emotionalBias || 0), 0) / data.responses.length;
      const averageScore = (avgLogic * 0.35 + avgClarity * 0.25 + avgRelevance * 0.3 + (10 - avgEmotionalBias) * 0.1);

      results.push({
        id,
        name: data.name,
        totalResponses: data.responses.length,
        averageScores: {
          logic: Math.round(avgLogic * 10) / 10,
          clarity: Math.round(avgClarity * 10) / 10,
          relevance: Math.round(avgRelevance * 10) / 10,
          emotionalBias: Math.round(avgEmotionalBias * 10) / 10
        },
        averageScore: Math.round(averageScore * 10) / 10,
        responses: data.responses
      });
    }
  }

  results.sort((a, b) => b.averageScore - a.averageScore);
  results.forEach((r, i) => { r.rank = i + 1; });

  // JSON format
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="debate-report-${roomCode}.json"`);
    return res.json({
      exportedAt: new Date().toISOString(),
      roomCode,
      topic: room.topic,
      totalRounds: room.currentRound,
      participants: results
    });
  }

  // Text format
  const winner = results[0];
  const reportDate = new Date().toLocaleString();
  
  let report = `
╔══════════════════════════════════════════════════════════════════════╗
║                      DEBAITOR - DISCUSSION REPORT                    ║
╚══════════════════════════════════════════════════════════════════════╝

Report Generated: ${reportDate}
Room Code: ${roomCode}
Topic: ${room.topic}
Total Rounds: ${room.currentRound}
Total Participants: ${results.length}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                              🏆 WINNER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${winner ? `${winner.name} (Score: ${winner.averageScore}/10)` : 'No winner'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                        FINAL STANDINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  results.forEach(p => {
    report += `
#${p.rank} ${p.name}
   Overall Score: ${p.averageScore}/10
   Responses: ${p.totalResponses}
   ├─ Logic:          ${p.averageScores?.logic || 0}/10
   ├─ Clarity:        ${p.averageScores?.clarity || 0}/10
   ├─ Relevance:      ${p.averageScores?.relevance || 0}/10
   └─ Emotional Bias: ${p.averageScores?.emotionalBias || 0}/10
`;
  });

  // Add complete conversation transcript
  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                     COMPLETE CONVERSATION TRANSCRIPT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  // Collect all responses with timestamps and organize by round
  const allResponses = [];
  results.forEach(p => {
    if (p.responses && p.responses.length > 0) {
      p.responses.forEach((response, idx) => {
        allResponses.push({
          name: p.name,
          round: response.round || idx + 1,
          transcript: response.transcript || '[No transcript available]',
          score: response.scores?.finalScore || 0,
          feedback: response.scores?.insight || '',
          timestamp: response.timestamp || Date.now()
        });
      });
    }
  });

  // Sort by round then timestamp
  allResponses.sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.timestamp - b.timestamp;
  });

  // Group by round
  let currentRound = 0;
  allResponses.forEach(response => {
    if (response.round !== currentRound) {
      currentRound = response.round;
      report += `
────────────────────── ROUND ${currentRound} ──────────────────────
`;
    }
    
    report += `
[${response.name}] (Score: ${response.score}/10)
"${response.transcript}"

AI Feedback: ${response.feedback || 'No feedback available'}
`;
  });

  if (allResponses.length === 0) {
    report += `
[No responses recorded in this debate]
`;
  }

  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                     Generated by DebAItor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="debate-report-${roomCode}.txt"`);
  res.send(report);
});

// ============ AI EVALUATION ============

function calculateFinalScore(scores) {
  const { logic, clarity, relevance, emotionalBias } = scores;
  return Math.round(((logic * 0.35) + (clarity * 0.25) + (relevance * 0.30) + ((10 - emotionalBias) * 0.10)) * 10) / 10;
}

async function evaluateResponse(topic, transcript) {
  const systemPrompt = `You are an impartial discussion evaluator.

Task:
Evaluate the following discussion argument based ONLY on how it is presented.

Evaluation Criteria (score each from 1 to 10):
1. Logic – How well-structured and logical the argument is.
2. Clarity – How clearly the idea is expressed.
3. Relevance – How well the argument stays on the given topic.
4. Emotional Bias – How emotional vs objective the argument is.

Return ONLY a valid JSON object:
{
  "logic": X,
  "clarity": X,
  "relevance": X,
  "emotionalBias": X,
  "summary": "Brief one-line summary"
}`;

  const userPrompt = `Topic: "${topic}"\n\nArgument:\n"${transcript}"`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    const responseText = completion.choices[0]?.message?.content || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('No valid JSON in response');
    }

    const scores = JSON.parse(jsonMatch[0]);
    scores.finalScore = calculateFinalScore(scores);
    
    return scores;
  } catch (error) {
    console.error('AI evaluation error:', error.message);
    return getMockEvaluation();
  }
}

// Mock functions
const MOCK_TRANSCRIPTS = [
  "I believe we need to consider both perspectives carefully before making a judgment.",
  "The evidence clearly shows that this approach has significant benefits.",
  "While there are valid concerns, the overall impact remains positive.",
  "We must prioritize long-term sustainability over short-term gains."
];

const MOCK_SUMMARIES = [
  "Presents a balanced perspective but lacks depth.",
  "Clear argument with good supporting evidence.",
  "Well-reasoned but could be more relevant to topic.",
  "Strong conviction but needs more logical structure."
];

function getMockTranscript() {
  return MOCK_TRANSCRIPTS[Math.floor(Math.random() * MOCK_TRANSCRIPTS.length)];
}

function getMockEvaluation() {
  const logic = Math.floor(Math.random() * 4) + 5;
  const clarity = Math.floor(Math.random() * 4) + 5;
  const relevance = Math.floor(Math.random() * 4) + 5;
  const emotionalBias = Math.floor(Math.random() * 5) + 2;
  const summary = MOCK_SUMMARIES[Math.floor(Math.random() * MOCK_SUMMARIES.length)];
  const finalScore = calculateFinalScore({ logic, clarity, relevance, emotionalBias });
  return { logic, clarity, relevance, emotionalBias, summary, finalScore };
}

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));

// Start server
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║      DebAItor - Turn-Based Debate MVP         ║
╠═══════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                ║
║  Storage: ${USE_FIRESTORE ? 'Firebase Firestore' : 'In-Memory'}             ║
║                                               ║
║  Host Flow:                                   ║
║  1. Create room → 2. Wait for players         ║
║  3. Start debate → 4. Control turns           ║
║  5. End debate → View results                 ║
╚═══════════════════════════════════════════════╝
    `);
  });
}

module.exports = app;
