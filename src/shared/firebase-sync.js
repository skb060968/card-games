/**
 * Card Games Platform Firebase Sync Module
 *
 * Handles all Firebase Realtime Database operations for online multiplayer:
 * room lifecycle, real-time sync, disconnect handling, and retry logic.
 *
 * Generalized with gameId parameter — all data stored under
 * `card-games/{gameId}-rooms/{roomCode}`.
 */

import { db, auth } from '../shared/firebase-config.js';
import {
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  off,
  onDisconnect,
} from 'firebase/database';
import { serializeCard, deserializeCard } from '../shared/deck.js';

/** Characters used for room codes — excludes ambiguous 0, O, I, l, 1 */
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Retry wrapper for Firebase write operations with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {number} [maxRetries=2] - Maximum number of retries
 * @param {number} [delayMs=500] - Base delay in milliseconds
 * @returns {Promise<*>} Result of the function call
 */
export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`Warning: Firebase retry ${attempt + 1}/${maxRetries}:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

/**
 * Generates a 4-character room code from the allowed charset.
 * Excludes ambiguous characters: 0, O, I, l, 1.
 * @returns {string} 4-character room code
 */
export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(Math.random() * ROOM_CODE_CHARSET.length);
    code += ROOM_CODE_CHARSET[idx];
  }
  return code;
}


/**
 * Creates a new online room in Firebase.
 * The host is automatically added as player_0.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} hostName - Display name of the host
 * @param {string} hostEmoji - Emoji avatar of the host
 * @returns {Promise<{ roomCode: string, playerIndex: number }>}
 */
export async function createRoom(gameId, hostName, hostEmoji) {
  const uid = auth.currentUser?.uid || 'anonymous';
  const roomCode = generateRoomCode();
  const roomRef = ref(db, `card-games/${gameId}-rooms/${roomCode}`);

  const roomData = {
    meta: {
      hostUid: uid,
      hostName: hostName,
      status: 'lobby',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      deckCount: 1,
    },
    players: {
      player_0: {
        name: hostName,
        emoji: hostEmoji,
        uid: uid,
        connected: true,
      },
    },
    game: null,
    ready: {},
  };

  await firebaseRetry(() => set(roomRef, roomData));

  return { roomCode, playerIndex: 0 };
}

/**
 * Joins an existing room as a new player.
 * Rejects if the room is not in lobby status or is full (6 players).
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The 4-character room code
 * @param {string} playerName - Display name of the joining player
 * @param {string} playerEmoji - Emoji avatar of the joining player
 * @returns {Promise<{ success: boolean, playerIndex?: number, reason?: string }>}
 */
export async function joinRoom(gameId, roomCode, playerName, playerEmoji) {
  const roomRef = ref(db, `card-games/${gameId}-rooms/${roomCode}`);

  const snapshot = await firebaseRetry(() => get(roomRef));

  if (!snapshot.exists()) {
    return { success: false, reason: 'Room not found' };
  }

  const data = snapshot.val();

  if (data.meta.status !== 'lobby') {
    return { success: false, reason: 'Game already in progress' };
  }

  // Check player count
  const players = data.players || {};
  const existingIndices = Object.keys(players)
    .map((key) => parseInt(key.replace('player_', ''), 10))
    .filter((n) => !isNaN(n));

  if (existingIndices.length >= 6) {
    return { success: false, reason: 'Room is full' };
  }

  const nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 0;
  const uid = auth.currentUser?.uid || 'anonymous';
  const playerKey = `player_${nextIndex}`;

  await firebaseRetry(() =>
    update(ref(db, `card-games/${gameId}-rooms/${roomCode}`), {
      [`players/${playerKey}`]: {
        name: playerName,
        emoji: playerEmoji,
        uid: uid,
        connected: true,
      },
      'meta/lastActivity': Date.now(),
    })
  );

  return { success: true, playerIndex: nextIndex };
}

/**
 * Subscribes to real-time room changes via Firebase onValue.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code to listen to
 * @param {object} callbacks - Callback functions for different data changes
 * @param {Function} [callbacks.onPlayersChange] - Called when players data changes
 * @param {Function} [callbacks.onGameUpdate] - Called when game data changes
 * @param {Function} [callbacks.onStatusChange] - Called when room status changes
 * @param {Function} [callbacks.onRoomDeleted] - Called when the room is deleted
 * @returns {Function} Unsubscribe function to stop listening
 */
export function listenRoom(gameId, roomCode, callbacks) {
  const roomRef = ref(db, `card-games/${gameId}-rooms/${roomCode}`);

  const handler = (snapshot) => {
    if (!snapshot.exists()) {
      if (callbacks.onRoomDeleted) callbacks.onRoomDeleted();
      return;
    }
    const data = snapshot.val();

    if (callbacks.onPlayersChange && data.players) {
      callbacks.onPlayersChange(data.players);
    }
    if (callbacks.onGameUpdate && data.game) {
      callbacks.onGameUpdate(data.game, data.lastMove || null);
    }
    if (callbacks.onStatusChange && data.meta) {
      callbacks.onStatusChange(data.meta.status);
    }
  };

  onValue(roomRef, handler);

  return () => {
    off(roomRef, 'value', handler);
  };
}


/**
 * Serializes a full game state for Firebase storage.
 * Converts Card objects to "rank+suit" strings.
 * @param {object} gameState - The in-memory GameState
 * @returns {object} Serialized game data for Firebase
 */
function serializeGameState(gameState) {
  const hands = {};
  const handCounts = {};
  const bounties = {};
  const bountyCounts = {};
  const eliminated = {};

  gameState.players.forEach((player, i) => {
    const key = `player_${i}`;
    hands[key] = player.hand.map(serializeCard);
    handCounts[key] = player.hand.length;
    bounties[key] = player.bounty.map(serializeCard);
    bountyCounts[key] = player.bounty.length;
    eliminated[key] = player.eliminated;
  });

  return {
    currentPlayerIndex: gameState.currentPlayerIndex,
    status: gameState.status,
    deckSize: gameState.deckSize,
    winnerIndex: gameState.winnerIndex != null ? gameState.winnerIndex : null,
    pile: gameState.pile.length > 0 ? gameState.pile.map(serializeCard) : [],
    hands,
    handCounts,
    bounties,
    bountyCounts,
    eliminated,
  };
}

/**
 * Host writes full serialized game state to Firebase (used on game start).
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code
 * @param {object} gameState - The in-memory GameState
 */
export async function writeGameState(gameId, roomCode, gameState) {
  const serialized = serializeGameState(gameState);

  await firebaseRetry(() =>
    update(ref(db, `card-games/${gameId}-rooms/${roomCode}`), {
      game: serialized,
      lastMove: null,
      'meta/status': 'active',
      'meta/lastActivity': Date.now(),
    })
  );
}

/**
 * Writes a card throw action to Firebase.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code
 * @param {number} playerIndex - The player who threw the card
 * @param {object} thrownCard - The card that was thrown ({ rank, suit })
 * @param {boolean} captured - Whether a capture occurred
 * @param {object} newGameState - The new GameState after the throw
 */
export async function writeThrow(gameId, roomCode, playerIndex, thrownCard, captured, newGameState) {
  const serialized = serializeGameState(newGameState);

  const lastMove = {
    playerIndex,
    card: serializeCard(thrownCard),
    captured,
    timestamp: Date.now(),
  };

  await firebaseRetry(() =>
    update(ref(db, `card-games/${gameId}-rooms/${roomCode}`), {
      game: serialized,
      lastMove,
      'meta/lastActivity': Date.now(),
    })
  );
}

/**
 * Sets up an onDisconnect handler to mark a player as disconnected
 * when their connection drops.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code
 * @param {number} playerIndex - The player index
 */
export function setupDisconnectHandler(gameId, roomCode, playerIndex) {
  const connectedRef = ref(
    db,
    `card-games/${gameId}-rooms/${roomCode}/players/player_${playerIndex}/connected`
  );
  onDisconnect(connectedRef)
    .set(false)
    .catch((err) => {
      console.warn('Warning: onDisconnect setup failed:', err.message);
    });
}

/**
 * Marks room as ended.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code
 */
export async function endRoom(gameId, roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `card-games/${gameId}-rooms/${roomCode}/meta`), {
      status: 'ended',
      lastActivity: Date.now(),
    })
  );
}

/**
 * Deletes room data from Firebase.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code
 */
export async function deleteRoom(gameId, roomCode) {
  const roomRef = ref(db, `card-games/${gameId}-rooms/${roomCode}`);
  await firebaseRetry(() => remove(roomRef));
}

/**
 * Resets room to lobby state for play again.
 * Clears game and ready data, keeps players.
 * @param {string} gameId - Game identifier (e.g. 'patte-par-patta')
 * @param {string} roomCode - The room code
 */
export async function resetRoom(gameId, roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `card-games/${gameId}-rooms/${roomCode}`), {
      'meta/status': 'lobby',
      'meta/lastActivity': Date.now(),
      game: null,
      lastMove: null,
      ready: {},
    })
  );
}
