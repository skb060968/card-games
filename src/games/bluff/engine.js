/**
 * Bluff — Game Engine
 *
 * Pure game logic: create, place cards, challenge resolution,
 * turn management, win detection, validation, serialization.
 * No DOM or Firebase dependencies.
 */

import { createDeck, shuffle, dealCards, serializeCard, deserializeCard } from '../../shared/deck.js';

/* ======= CONSTANTS ======= */

const VALID_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CHALLENGE_WINDOW_MS = 5000; // 5 seconds

/* ======= GAME CREATION ======= */

/**
 * Creates initial Bluff game state.
 * Shuffles a 52-card deck, deals equally, discards remainder.
 * @param {Array<{name: string, emoji: string}>} playerInfos — 2 to 4 players
 * @returns {object} GameState
 */
export function createGame(playerInfos) {
  const n = playerInfos.length;
  if (n < 2 || n > 4) {
    throw new Error(`Invalid player count: ${n}. Must be 2-4 players.`);
  }

  const deck = createDeck();
  shuffle(deck);

  const hands = dealCards(deck, n);

  const players = playerInfos.map((info, i) => ({
    name: info.name,
    emoji: info.emoji,
    hand: hands[i],
    connected: true,
  }));

  return {
    players,
    centerPile: [],
    currentPlayerIndex: 0,
    phase: 'placing',
    lastPlacement: null,
    challengeDeadline: null,
    status: 'playing',
    winnerIndex: null,
    deckSize: 52,
    currentRank: null,
    roundStartPlayer: 0,
    playersActedThisRound: [],
  };
}

/* ======= CARD PLACEMENT ======= */

/**
 * Places 1–4 cards from the active player's hand onto the center pile.
 * Stores actual cards and declared rank separately.
 * Transitions to challengeWindow phase.
 * @param {object} state
 * @param {number[]} cardIndices — indices into active player's hand (1–4 cards)
 * @param {string} declaredRank — one of A,2,3,...,K
 * @returns {object} new GameState with phase 'challengeWindow'
 */
export function placeCards(state, cardIndices, declaredRank) {
  if (state.phase !== 'placing') {
    throw new Error('Cannot place cards: not in placing phase');
  }

  if (!cardIndices || cardIndices.length < 1 || cardIndices.length > 4) {
    throw new Error(`Must place 1-4 cards, got ${cardIndices ? cardIndices.length : 0}`);
  }

  if (!VALID_RANKS.includes(declaredRank)) {
    throw new Error(`Invalid declared rank: ${declaredRank}`);
  }

  // Round-based rank enforcement
  if (state.currentRank !== null && state.currentRank !== undefined && declaredRank !== state.currentRank) {
    throw new Error(`Must declare ${state.currentRank} this round (got ${declaredRank})`);
  }

  const playerIdx = state.currentPlayerIndex;
  const player = state.players[playerIdx];

  // Validate indices
  const uniqueIndices = [...new Set(cardIndices)].sort((a, b) => b - a);
  if (uniqueIndices.length !== cardIndices.length) {
    throw new Error('Duplicate card indices');
  }

  for (const idx of uniqueIndices) {
    if (idx < 0 || idx >= player.hand.length) {
      throw new Error(`Card index ${idx} out of range (hand size: ${player.hand.length})`);
    }
  }

  // Extract actual cards and remove from hand
  const actualCards = cardIndices.map((idx) => player.hand[idx]);
  const newHand = [...player.hand];
  // Remove from highest index first to preserve lower indices
  for (const idx of uniqueIndices) {
    newHand.splice(idx, 1);
  }

  const newCenterPile = [...state.centerPile, ...actualCards];

  const newPlayers = state.players.map((p, i) => {
    if (i === playerIdx) return { ...p, hand: newHand };
    return { ...p };
  });

  // Set currentRank if this is the first placement of the round
  const newCurrentRank = state.currentRank || declaredRank;

  // Track that this player has acted this round
  const newPlayersActed = state.playersActedThisRound
    ? [...state.playersActedThisRound]
    : [];
  if (!newPlayersActed.includes(playerIdx)) {
    newPlayersActed.push(playerIdx);
  }

  return {
    ...state,
    players: newPlayers,
    centerPile: newCenterPile,
    phase: 'challengeWindow',
    lastPlacement: {
      playerIndex: playerIdx,
      actualCards,
      declaredRank,
      count: actualCards.length,
    },
    challengeDeadline: Date.now() + CHALLENGE_WINDOW_MS,
    currentRank: newCurrentRank,
    roundStartPlayer: state.currentRank ? state.roundStartPlayer : playerIdx,
    playersActedThisRound: newPlayersActed,
  };
}

/* ======= PASS TURN ======= */

/**
 * Current player passes their turn (places no cards).
 * Adds player to playersActedThisRound, advances turn.
 * If all players have acted, resets the round.
 * @param {object} state — must be in placing phase
 * @returns {object} new GameState
 */
export function passCard(state) {
  if (state.phase !== 'placing') {
    throw new Error('Cannot pass: not in placing phase');
  }

  if (state.currentRank === null || state.currentRank === undefined) {
    throw new Error('Cannot pass: you must pick a rank first (no current rank set)');
  }

  const playerIdx = state.currentPlayerIndex;
  const numPlayers = state.players.length;

  // Track that this player has acted this round
  const newPlayersActed = state.playersActedThisRound
    ? [...state.playersActedThisRound]
    : [];
  if (!newPlayersActed.includes(playerIdx)) {
    newPlayersActed.push(playerIdx);
  }

  // Check if round is complete (all players have acted)
  const roundComplete = newPlayersActed.length >= numPlayers;

  const nextPlayer = (playerIdx + 1) % numPlayers;

  if (roundComplete) {
    // Round over — reset rank, next player picks a new rank
    return {
      ...state,
      currentPlayerIndex: nextPlayer,
      phase: 'placing',
      currentRank: null,
      roundStartPlayer: nextPlayer,
      playersActedThisRound: [],
    };
  }

  return {
    ...state,
    currentPlayerIndex: nextPlayer,
    phase: 'placing',
    playersActedThisRound: newPlayersActed,
  };
}

/* ======= CHALLENGE RESOLUTION ======= */

/**
 * Resolves a challenge against the most recent placement.
 * Reveals actual cards, compares to declared rank.
 * Assigns entire center pile to the loser.
 * @param {object} state — must be in challengeWindow phase
 * @param {number} challengerIndex — index of the challenging player
 * @returns {{ newState: object, bluffCaught: boolean, revealedCards: Array }}
 */
export function resolveChallenge(state, challengerIndex) {
  if (state.phase !== 'challengeWindow') {
    throw new Error('Cannot resolve challenge: not in challengeWindow phase');
  }

  if (!state.lastPlacement) {
    throw new Error('No placement to challenge');
  }

  const placerIndex = state.lastPlacement.playerIndex;

  if (challengerIndex === placerIndex) {
    throw new Error('Cannot challenge your own placement');
  }

  if (challengerIndex < 0 || challengerIndex >= state.players.length) {
    throw new Error(`Invalid challenger index: ${challengerIndex}`);
  }

  const { actualCards, declaredRank } = state.lastPlacement;
  const revealedCards = [...actualCards];

  // Check if any actual card doesn't match the declared rank
  const bluffCaught = actualCards.some((card) => card.rank !== declaredRank);

  // Loser takes the entire center pile
  const loserIndex = bluffCaught ? placerIndex : challengerIndex;
  const pileCards = [...state.centerPile];

  const newPlayers = state.players.map((p, i) => {
    if (i === loserIndex) {
      return { ...p, hand: [...p.hand, ...pileCards] };
    }
    return { ...p };
  });

  // Advance turn to next player after the placer
  const nextPlayer = (placerIndex + 1) % state.players.length;

  return {
    newState: {
      ...state,
      players: newPlayers,
      centerPile: [],
      currentPlayerIndex: nextPlayer,
      phase: 'placing',
      lastPlacement: null,
      challengeDeadline: null,
      status: 'playing',
    },
    bluffCaught,
    revealedCards,
  };
}

/* ======= CHALLENGE EXPIRY ======= */

/**
 * Expires the challenge window without a challenge.
 * Advances turn to next player. Checks win condition if placer's hand is empty.
 * @param {object} state — must be in challengeWindow phase
 * @returns {object} GameState
 */
export function expireChallenge(state) {
  if (state.phase !== 'challengeWindow') {
    throw new Error('Cannot expire challenge: not in challengeWindow phase');
  }

  const placerIndex = state.lastPlacement ? state.lastPlacement.playerIndex : state.currentPlayerIndex;
  const placer = state.players[placerIndex];

  // If placer's hand is empty, they win
  if (placer.hand.length === 0) {
    return {
      ...state,
      phase: 'finished',
      status: 'finished',
      winnerIndex: placerIndex,
      lastPlacement: null,
      challengeDeadline: null,
    };
  }

  const numPlayers = state.players.length;
  const playersActed = state.playersActedThisRound || [];

  // Check if round is complete (all players have acted)
  const roundComplete = playersActed.length >= numPlayers;

  // Advance turn to next player after the placer
  const nextPlayer = (placerIndex + 1) % numPlayers;

  if (roundComplete) {
    // Round over — reset rank, next player picks a new rank
    return {
      ...state,
      currentPlayerIndex: nextPlayer,
      phase: 'placing',
      lastPlacement: null,
      challengeDeadline: null,
      currentRank: null,
      roundStartPlayer: nextPlayer,
      playersActedThisRound: [],
    };
  }

  return {
    ...state,
    currentPlayerIndex: nextPlayer,
    phase: 'placing',
    lastPlacement: null,
    challengeDeadline: null,
  };
}

/* ======= STATE VALIDATION ======= */

/**
 * Validates state integrity: total cards across all hands + centerPile = 52.
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  let total = state.centerPile.length;
  for (const player of state.players) {
    total += player.hand.length;
  }

  // Count cards in lastPlacement.actualCards only if they are NOT already in centerPile
  // (they should already be in centerPile after placeCards, so no double-counting needed)

  if (total !== 52) {
    return { valid: false, error: `Card count mismatch: expected 52, found ${total}` };
  }
  return { valid: true };
}

/* ======= SERIALIZATION ======= */

/**
 * Serializes game state for Firebase storage.
 * @param {object} state
 * @returns {object} Firebase-compatible plain object
 */
export function serializeState(state) {
  const hands = {};
  const handCounts = {};

  state.players.forEach((p, i) => {
    const key = `player_${i}`;
    hands[key] = p.hand.map(serializeCard);
    handCounts[key] = p.hand.length;
  });

  let lastPlacement = null;
  if (state.lastPlacement) {
    lastPlacement = {
      playerIndex: state.lastPlacement.playerIndex,
      actualCards: state.lastPlacement.actualCards.map(serializeCard),
      declaredRank: state.lastPlacement.declaredRank,
      count: state.lastPlacement.count,
    };
  }

  return {
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    status: state.status,
    deckSize: state.deckSize,
    winnerIndex: state.winnerIndex != null ? state.winnerIndex : null,
    centerPile: state.centerPile.map(serializeCard),
    hands,
    handCounts,
    lastPlacement,
    challengeDeadline: state.challengeDeadline,
    currentRank: state.currentRank || null,
    roundStartPlayer: state.roundStartPlayer || 0,
    playersActedThisRound: state.playersActedThisRound || [],
  };
}

/**
 * Deserializes game state from Firebase data.
 * @param {object} gameData — serialized game data from Firebase
 * @param {object} playersData — player info from Firebase
 * @returns {object} GameState
 */
export function deserializeState(gameData, playersData) {
  const playerKeys = Object.keys(playersData).sort();
  const players = playerKeys.map((key, i) => {
    const pData = playersData[key];
    const rawHand = (gameData.hands && gameData.hands[key]) || [];
    const hand = Array.isArray(rawHand)
      ? rawHand.map(deserializeCard)
      : Object.values(rawHand).map(deserializeCard);

    return {
      name: pData.name || `Player ${i + 1}`,
      emoji: pData.emoji || '😀',
      hand,
      connected: pData.connected !== false,
    };
  });

  const rawPile = gameData.centerPile || [];
  const centerPile = Array.isArray(rawPile)
    ? rawPile.map(deserializeCard)
    : Object.values(rawPile).map(deserializeCard);

  let lastPlacement = null;
  if (gameData.lastPlacement) {
    const lp = gameData.lastPlacement;
    const rawActual = lp.actualCards || [];
    const actualCards = Array.isArray(rawActual)
      ? rawActual.map(deserializeCard)
      : Object.values(rawActual).map(deserializeCard);

    lastPlacement = {
      playerIndex: lp.playerIndex,
      actualCards,
      declaredRank: lp.declaredRank,
      count: lp.count,
    };
  }

  return {
    players,
    centerPile,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    phase: gameData.phase || 'placing',
    lastPlacement,
    challengeDeadline: gameData.challengeDeadline || null,
    status: gameData.status || 'playing',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
    deckSize: gameData.deckSize || 52,
    currentRank: gameData.currentRank || null,
    roundStartPlayer: gameData.roundStartPlayer || 0,
    playersActedThisRound: gameData.playersActedThisRound
      ? (Array.isArray(gameData.playersActedThisRound)
          ? gameData.playersActedThisRound
          : Object.values(gameData.playersActedThisRound))
      : [],
  };
}
