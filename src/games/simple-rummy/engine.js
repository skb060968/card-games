/**
 * Simple Rummy — Game Engine
 *
 * Pure game logic: create, draw, discard, win detection, validation.
 * No DOM or Firebase dependencies.
 */

import { createDeck, shuffle, serializeCard, deserializeCard } from '../../shared/deck.js';

/* ======= CONSTANTS ======= */

const RANK_VALUES = {
  'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13,
};

const CARDS_PER_PLAYER = 10;

/* ======= GAME CREATION ======= */

/**
 * Creates initial game state.
 * Auto-selects 1 deck for 2-3 players, 2 decks for 4 players.
 * @param {Array<{name: string, emoji: string}>} playerInfos
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
    winGroups: null,
  };
}

/* ======= DRAW ======= */

/**
 * Draws a card from the specified source.
 * @param {object} state - GameState (turnPhase must be 'draw')
 * @param {'drawPile'|'discardPile'} source
 * @returns {object} new GameState
 */
export function drawCard(state, source) {
  if (state.turnPhase !== 'draw') {
    throw new Error('Cannot draw: not in draw phase');
  }

  let newDrawPile = [...state.drawPile];
  let newDiscardPile = [...state.discardPile];

  // Auto-reshuffle if draw pile empty (regardless of source)
  if (newDrawPile.length === 0 && newDiscardPile.length > 1) {
    const reshuffled = reshuffleDiscardPile({
      ...state,
      drawPile: newDrawPile,
      discardPile: newDiscardPile,
    });
    newDrawPile = reshuffled.drawPile;
    newDiscardPile = reshuffled.discardPile;
  }

  // If still empty after reshuffle attempt and drawing from draw pile
  if (source === 'drawPile' && newDrawPile.length === 0) {
    // Can't draw — game ends as draw
    return {
      ...state,
      status: 'finished',
      winnerIndex: null,
      winGroups: null,
    };
  }

  let drawnCard;
  if (source === 'drawPile') {
    drawnCard = newDrawPile.pop();
  } else {
    drawnCard = newDiscardPile.pop();
  }

  if (!drawnCard) {
    throw new Error(`Cannot draw from ${source}: pile is empty`);
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
 * Checks win condition, advances turn.
 * @param {object} state - GameState (turnPhase must be 'discard')
 * @param {number} handIndex
 * @returns {{ newState: object, won: boolean, winGroups: Array|null }}
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

  // Check win
  const winResult = checkWin(newHand);

  const newPlayers = state.players.map((p, i) => {
    if (i === playerIdx) return { ...p, hand: newHand };
    return { ...p };
  });

  if (winResult.valid) {
    return {
      newState: {
        ...state,
        players: newPlayers,
        discardPile: newDiscardPile,
        status: 'finished',
        winnerIndex: playerIdx,
        winGroups: winResult.groups,
        turnPhase: 'draw',
      },
      won: true,
      winGroups: winResult.groups,
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
    winGroups: null,
  };
}

/* ======= WIN DETECTION ======= */

/**
 * Checks if a 10-card hand can be partitioned into 2 groups of 3 + 1 group of 4.
 * @param {Array<{rank: string, suit: string}>} hand
 * @returns {{ valid: boolean, groups: Array<Array>|null }}
 */
export function checkWin(hand) {
  if (hand.length !== CARDS_PER_PLAYER) return { valid: false, groups: null };

  // Try all ways to partition 10 cards into groups of [4, 3, 3]
  const result = findPartition(hand, [4, 3, 3]);
  if (result) return { valid: true, groups: result };

  return { valid: false, groups: null };
}

/**
 * Recursive backtracking to partition cards into groups of given sizes.
 * @param {Array} cards - remaining cards
 * @param {number[]} sizes - remaining group sizes to fill
 * @returns {Array<Array>|null}
 */
function findPartition(cards, sizes) {
  if (sizes.length === 0) {
    return cards.length === 0 ? [] : null;
  }

  const size = sizes[0];
  const remainingSizes = sizes.slice(1);
  const combos = getCombinations(cards, size);

  for (const combo of combos) {
    if (isValidSet(combo) || isValidSequence(combo)) {
      const remaining = removeCards(cards, combo);
      const result = findPartition(remaining, remainingSizes);
      if (result !== null) {
        return [combo, ...result];
      }
    }
  }

  return null;
}

/**
 * Generates all combinations of `size` elements from `arr`.
 */
function getCombinations(arr, size) {
  const results = [];
  function helper(start, current) {
    if (current.length === size) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      helper(i + 1, current);
      current.pop();
    }
  }
  helper(0, []);
  return results;
}

/**
 * Removes specific card objects from array (by reference match via index tracking).
 */
function removeCards(cards, toRemove) {
  const remaining = [...cards];
  for (const card of toRemove) {
    const idx = remaining.findIndex(
      (c) => c.rank === card.rank && c.suit === card.suit
    );
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return remaining;
}

/* ======= VALIDATION HELPERS ======= */

/**
 * Validates a group as a set: same rank, distinct suits.
 * @param {Array<{rank: string, suit: string}>} cards
 * @returns {boolean}
 */
export function isValidSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const rank = cards[0].rank;
  const suits = new Set();
  for (const card of cards) {
    if (card.rank !== rank) return false;
    if (suits.has(card.suit)) return false;
    suits.add(card.suit);
  }
  return true;
}

/**
 * Validates a group as a sequence: consecutive ranks, same suit.
 * Ace can be low (A-2-3) or high (Q-K-A). K-A-2 wrap is invalid.
 * @param {Array<{rank: string, suit: string}>} cards
 * @returns {boolean}
 */
export function isValidSequence(cards) {
  if (cards.length < 3 || cards.length > 4) return false;

  const suit = cards[0].suit;
  if (!cards.every((c) => c.suit === suit)) return false;

  const values = cards.map((c) => RANK_VALUES[c.rank]).sort((a, b) => a - b);

  // Check normal consecutive
  if (isConsecutive(values)) return true;

  // Check Ace-high: replace A(1) with 14
  if (values.includes(1)) {
    const highValues = values.map((v) => (v === 1 ? 14 : v)).sort((a, b) => a - b);
    if (isConsecutive(highValues)) return true;
  }

  return false;
}

function isConsecutive(sorted) {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

/* ======= RESHUFFLE ======= */

/**
 * Reshuffles discard pile (except top card) into draw pile.
 * @param {object} state
 * @returns {object} new state
 */
export function reshuffleDiscardPile(state) {
  if (state.discardPile.length <= 1) {
    return state; // Nothing to reshuffle
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
 * Validates state integrity.
 * @param {object} state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateState(state) {
  let total = state.drawPile.length + state.discardPile.length;
  for (const player of state.players) {
    total += player.hand.length;
    if (player.hand.length > 11) {
      return { valid: false, error: `Player ${player.name} has ${player.hand.length} cards (max 11)` };
    }
  }
  if (total !== state.deckSize) {
    return { valid: false, error: `Card count mismatch: expected ${state.deckSize}, found ${total}` };
  }
  return { valid: true };
}

/* ======= SERIALIZATION ======= */

/**
 * Serializes game state for Firebase.
 * @param {object} state
 * @returns {object}
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
    winnerIndex: state.winnerIndex,
    winGroups: state.winGroups
      ? state.winGroups.map((g) => g.map(serializeCard))
      : null,
    drawPile: state.drawPile.map(serializeCard),
    discardPile: state.discardPile.map(serializeCard),
    hands,
    handCounts,
  };
}

/**
 * Deserializes game state from Firebase data + player info.
 * @param {object} gameData
 * @param {object} playersData
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

  let winGroups = null;
  if (gameData.winGroups) {
    winGroups = gameData.winGroups.map((g) =>
      Array.isArray(g) ? g.map(deserializeCard) : Object.values(g).map(deserializeCard)
    );
  }

  return {
    players,
    drawPile,
    discardPile,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    turnPhase: gameData.turnPhase || 'draw',
    deckSize: gameData.deckSize || 52,
    status: gameData.status || 'playing',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
    winGroups,
  };
}
