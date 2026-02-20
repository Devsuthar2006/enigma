/**
 * Firebase Firestore Configuration
 * Simple setup using environment variables
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
function initializeFirebase() {
  // Check if already initialized
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  // Get credentials from environment variables
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) {
    // Strip surrounding quotes if copied from .env file
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('\n⚠️  Firebase credentials not found in environment variables.');
    console.warn('   Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY to .env');
    console.warn('   Falling back to in-memory storage.\n');
    return null;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey
      })
    });

    console.log('✅ Firebase Firestore initialized successfully!\n');
    const firestore = admin.firestore();
    // Handle undefined values gracefully
    firestore.settings({ ignoreUndefinedProperties: true });
    return firestore;
  } catch (error) {
    console.error('❌ Firebase initialization failed:', error.message);
    return null;
  }
}

const db = initializeFirebase();

// ============ FIRESTORE HELPER FUNCTIONS ============

/**
 * Create a new room in Firestore
 */
async function createRoom(roomCode, data) {
  if (!db) return false;
  
  try {
    await db.collection('rooms').doc(roomCode).set({
      topic: data.topic,
      mode: data.mode || 'debate',
      hostId: data.hostId,
      status: data.status,
      locked: data.locked,
      currentTurn: data.currentTurn,
      turnOrder: data.turnOrder,
      currentRound: data.currentRound,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('Firestore createRoom error:', error.message);
    return false;
  }
}

/**
 * Get room data from Firestore
 */
async function getRoom(roomCode) {
  if (!db) return null;
  
  try {
    const doc = await db.collection('rooms').doc(roomCode).get();
    if (!doc.exists) return null;
    
    const roomData = doc.data();
    
    // Get participants subcollection
    const participantsSnap = await db.collection('rooms').doc(roomCode)
      .collection('participants').get();
    
    const participants = new Map();
    participantsSnap.forEach(pDoc => {
      participants.set(pDoc.id, pDoc.data());
    });
    
    // Get arguments subcollection
    const argumentsSnap = await db.collection('rooms').doc(roomCode)
      .collection('arguments').get();
    
    // Organize arguments by participant
    argumentsSnap.forEach(aDoc => {
      const argData = aDoc.data();
      const participant = participants.get(argData.participantId);
      if (participant) {
        if (!participant.responses) participant.responses = [];
        participant.responses.push({
          round: argData.round,
          transcript: argData.text,
          scores: argData.scores || {},
          submittedAt: argData.submittedAt
        });
      }
    });
    
    return {
      ...roomData,
      participants,
      createdAt: roomData.createdAt?.toMillis() || Date.now()
    };
  } catch (error) {
    console.error('Firestore getRoom error:', error.message);
    return null;
  }
}

/**
 * Update room data in Firestore
 */
async function updateRoom(roomCode, updates) {
  if (!db) return false;
  
  try {
    await db.collection('rooms').doc(roomCode).update(updates);
    return true;
  } catch (error) {
    console.error('Firestore updateRoom error:', error.message);
    return false;
  }
}

/**
 * Add participant to room
 */
async function addParticipant(roomCode, participantId, data) {
  if (!db) return false;
  
  try {
    await db.collection('rooms').doc(roomCode)
      .collection('participants').doc(participantId).set({
        name: data.name,
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    return true;
  } catch (error) {
    console.error('Firestore addParticipant error:', error.message);
    return false;
  }
}

/**
 * Get all participants in a room
 */
async function getParticipants(roomCode) {
  if (!db) return new Map();
  
  try {
    const snap = await db.collection('rooms').doc(roomCode)
      .collection('participants').get();
    
    const participants = new Map();
    snap.forEach(doc => {
      participants.set(doc.id, doc.data());
    });
    return participants;
  } catch (error) {
    console.error('Firestore getParticipants error:', error.message);
    return new Map();
  }
}

/**
 * Add argument/response to room
 */
async function addArgument(roomCode, argumentId, data) {
  if (!db) return false;
  
  try {
    await db.collection('rooms').doc(roomCode)
      .collection('arguments').doc(argumentId).set({
        participantId: data.participantId,
        text: data.text,
        round: data.round,
        scores: data.scores,
        submittedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    return true;
  } catch (error) {
    console.error('Firestore addArgument error:', error.message);
    return false;
  }
}

/**
 * Get all arguments in a room
 */
async function getArguments(roomCode) {
  if (!db) return [];
  
  try {
    const snap = await db.collection('rooms').doc(roomCode)
      .collection('arguments').get();
    
    const args = [];
    snap.forEach(doc => {
      args.push({ id: doc.id, ...doc.data() });
    });
    return args;
  } catch (error) {
    console.error('Firestore getArguments error:', error.message);
    return [];
  }
}

/**
 * Save report to room
 */
async function saveReport(roomCode, reportData) {
  if (!db) return false;
  
  try {
    await db.collection('rooms').doc(roomCode)
      .collection('report').doc('final').set({
        evaluationScores: reportData.evaluationScores,
        summaries: reportData.summaries,
        overallSummary: reportData.overallSummary,
        results: reportData.results,
        generatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    return true;
  } catch (error) {
    console.error('Firestore saveReport error:', error.message);
    return false;
  }
}

/**
 * Get report from room
 */
async function getReport(roomCode) {
  if (!db) return null;
  
  try {
    const doc = await db.collection('rooms').doc(roomCode)
      .collection('report').doc('final').get();
    
    if (!doc.exists) return null;
    return doc.data();
  } catch (error) {
    console.error('Firestore getReport error:', error.message);
    return null;
  }
}

/**
 * Check if room exists
 */
async function roomExists(roomCode) {
  if (!db) return false;
  
  try {
    const doc = await db.collection('rooms').doc(roomCode).get();
    return doc.exists;
  } catch (error) {
    console.error('Firestore roomExists error:', error.message);
    return false;
  }
}

module.exports = {
  db,
  createRoom,
  getRoom,
  updateRoom,
  addParticipant,
  getParticipants,
  addArgument,
  getArguments,
  saveReport,
  getReport,
  roomExists
};
