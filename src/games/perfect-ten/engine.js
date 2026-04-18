/**
 * Perfect Ten — Game Engine
 *
 * Pure game logic: create, draw, discard, win detection,
 * validation, serialization. No DOM or Firebase dependencies.
 *
 * Win condition: hand contains at least one card of each rank A through 10.
 * Face cards (J, Q, K) do not count toward the win condition.
 */

import { createDeck, shuffle, serializeCard, deserializeCard } from '../../shared/deck.js';

/* ======= CONSTANTS ======= */

const CARDS_PER_PLAYER = 10;
const TARGET_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const MAX_HAND_SIZE = 11; // 10 starting + 1 drawn before discard

/* ======= GAME CREATION ======= */

/**
 * Creates initial Perfect Ten game state.
 * 1 deck for 2-3 players, 2 decks for 4 players.
 * Deals 5 cards to each player, places one card on discard pile,
 * remaining cards form the draw pile.
 * @param {Array<{name: string, emoji: string}>} playerInfos — 2 to 4 players
 * @returns {object} GameState
 */
export function createGame(playerInfos) {
  const n = playerInfos.length;
  if (n < 2 || n > 4) {
    throw new Error(`Invalid player count: ${n}. Must be 2-4 players.`);
  }

  const deckCount = n >= 4 ? 2 : 1;
  let deck = createDeck();
  if (deckCount === 2) deck = [...deck, ...createDeck()];
  shuffle(deck);

  // Deal 5 cards to each player
  const hands = [];
  let idx = 0;
  for (let i = 0; i < n; i++) {
    hands.push(deck.slice(idx, idx + CARDS_PER_PLAYER));
    idx += CARDS_PER_PLAYER;
  }

  // First card after dealing goes to discard pile
  const discardPile = [deck[idx]];
  idx++;
  const drawPile = deck.slice(idx);

  const players = playerInfos.map((info, i) => ({
    name: info.name,
    emoji: info.emoji,
    hand: hands[i],
    connected: true,
  }));

  return {
    players,
    drawPile,
    discardPile,
    currentPlayerIndex: 0,
    turnPhase: 'draw',
    deckSize: deck.length,
    status: 'playing',
    winnerIndex: null,
  };
}

/* ======= DRAW ======= */

/**
 * Draws a card from the specified source.
 * Handles reshuffle when draw pile is empty.
 * @param {object} state — GameState (turnPhase must be 'draw')
 * @param {'drawPile'|'discardPile'} source
 * @returns {object} new GameState with turnPhase 'discard'
 */
export function drawCard(state, source) {
  if (state.turnPhase !== 'draw') {
    throw new Error('Cannot draw: not in draw phase');
  }

  let newDrawPile = [...state.drawPile];
  let newDiscardPile = [...state.discardPile];

  // Auto-reshuffle if draw pile empty and drawing from it
  if (source === 'drawPile' && newDrawPile.length === 0) {
    if (newDiscardPile.length <= 1) {
      // Can't reshuffle — game ends as draw
      return {
        ...state,
        status: 'finished',
        winnerIndex: null,
      };
    }
    const reshuffled = reshuffleDiscardPile({
      ...state,
      drawPile: newDrawPile,
      discardPile: newDiscardPile,
    });
    newDrawPile = reshuffled.drawPile;
    newDiscardPile = reshuffled.discardPile;
  }

  let drawnCard;
  if (source === 'drawPile') {
    if (newDrawPile.length === 0) {
      // Still empty after reshuffle attempt — shouldn't happen but guard
      return { ...state, status: 'finished', winnerIndex: null };
    }
    drawnCard = newDrawPile.pop();
  } else {
    if (newDiscardPile.length === 0) {
      throw new Error('Cannot draw from discardPile: pile is empty');
    }
    drawnCard = newDiscardPile.pop();
  }

  const playerIdx = state.currentPlayerIndex;
  const newPlayers = state.players.map((p, i) => {
    if (i === playerIdx) {
      return { ...p, hand: [...p.hand, drawnCard] };
    }
    return { ...p };
  });

  return {
    ...state,
    players: newPlayers,
    drawPile: newDrawPile,
    discardPile: newDiscardPile,
    turnPhase: 'discard',
  };
}

/* ======= DISCARD ======= */

/**
 * Discards a card from the current player's hand.
 * Checks win condition, advances turn if no win.
 * @param {object} state — GameState (turnPhase must be 'discard')
 * @param {number} handIndex
 * @returns {{ newState: object, won: boolean }}
 */
export function discardCard(state, handIndex) {
  if (state.turnPhase !== 'discard') {
    throw new Error('Cannot discard: not in discard phase');
  }

  const playerIdx = state.currentPlayerIndex;
  const player = state.players[playerIdx];

  if (handIndex < 0 || handIndex >= player.hand.length) {
    throw new Error(`Invalid hand index: ${handIndex}`);
  }

  const discarded = player.hand[handIndex];
  const newHand = [...player.hand.slice(0, handIndex), ...player.hand.slice(handIndex + 1)];
  const newDiscardPile = [...state.discardPile, discarded];

  const newPlayers = state.players.map((p, i) => {
    if (i === playerIdx) return { ...p, hand: newHand };
    return { ...p };
  });

  // Check win condition
  const won = checkWinCondition(newHand);

  if (won) {
    return {
      newState: {
        ...state,
        players: newPlayers,
        discardPile: newDiscardPile,
        status: 'finished',
        winnerIndex: playerIdx,
        turnPhase: 'draw',
      },
      won: true,
    };
  }

  // Advance turn
  const nextPlayer = (playerIdx + 1) % state.players.length;

  return {
    newState: {
      ...state,
      players: newPlayers,
      discardPile: newDiscardPile,
      currentPlayerIndex: nextPlayer,
      turnPhase: 'draw',
    },
    won: false,
  };
}

/* ======= WIN CONDITION ======= */

/**
 * Checks if a hand contains at least one card of each rank from A through 10.
 * Face cards (J, Q, K) do not count.
 * @param {Array<{rank: string, suit: string}>} hand
 * @returns {boolean}
 */
export function checkWinCondition(hand) {
  const collectedRanks = new Set();
  for (const card of hand) {
    if (TARGET_RANKS.includes(card.rank)) {
      collectedRanks.add(card.rank);
    }
  }
  return collectedRanks.size === TARGET_RANKS.length;
}

/**
 * Returns the set of collected target ranks from a hand.
 * @param {Array<{rank: string, suit: string}>} hand
 * @returns {Set<string>}
 */
export function getCollectedRanks(hand) {
  const collected = new Set();
  for (const card of hand) {
    if (TARGET_RANKS.includes(card.rank)) {
      collected.add(card.rank);
    }
  }
  return collected;
}

/* ======= RESHUFFLE ======= */

/**
 * Reshuffles discard pile (except top card) into draw pile.
 * @param {object} state
 * @returns {object} new state with reshuffled piles
 */
export function reshuffleDiscardPile(state) {
  if (state.discardPile.length <= 1) {
    return state;
  }

  const topCard = state.discardPile[state.discardPile.length - 1];
  const cardsToShuffle = state.discardPile.slice(0, -1);
  shuffle(cardsToShuffle);

  return {
    ...state,
    drawPile: cardsToShuffle,
    discardPile: [topCard],
  };
}

/* ======= STATE VALIDATION ======= */

/**
 * Validates state integrity:
 * - Total card count equals deckSize
 * - No player has more than 6 cards
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  let total = state.drawPile.length + state.discardPile.length;
  for (const player of state.players) {
    total += player.hand.length;
    if (player.hand.length > MAX_HAND_SIZE) {
      return {
        valid: false,
        error: `Player ${player.name} has ${player.hand.length} cards (max ${MAX_HAND_SIZE})`,
      };
    }
  }
  if (total !== state.deckSize) {
    return {
      valid: false,
      error: `Card count mismatch: expected ${state.deckSize}, found ${total}`,
    };
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

  return {
    currentPlayerIndex: state.currentPlayerIndex,
    turnPhase: state.turnPhase,
    status: state.status,
    deckSize: state.deckSize,
    winnerIndex: state.winnerIndex != null ? state.winnerIndex : null,
    drawPile: state.drawPile.map(serializeCard),
    discardPile: state.discardPile.map(serializeCard),
    hands,
    handCounts,
  };
}

/**
 * Deserializes game state from Firebase data + player info.
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

  const rawDrawPile = gameData.drawPile || [];
  const drawPile = Array.isArray(rawDrawPile)
    ? rawDrawPile.map(deserializeCard)
    : Object.values(rawDrawPile).map(deserializeCard);

  const rawDiscardPile = gameData.discardPile || [];
  const discardPile = Array.isArray(rawDiscardPile)
    ? rawDiscardPile.map(deserializeCard)
    : Object.values(rawDiscardPile).map(deserializeCard);

  return {
    players,
    drawPile,
    discardPile,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    turnPhase: gameData.turnPhase || 'draw',
    deckSize: gameData.deckSize || 52,
    status: gameData.status || 'playing',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
  };
}
