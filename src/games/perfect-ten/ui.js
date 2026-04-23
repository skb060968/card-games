/**
 * Perfect Ten — UI Module
 *
 * Renders gameplay screen: all-players bar with face-down strips + rank count,
 * draw/discard piles, rank tracker, local hand with arc layout, self info bar.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { getCollectedRanks } from './engine.js';
import { calculatePot, getPlayerMetric, renderPotDisplay } from '../../shared/win-pot-calculator.js';

/* ======= CONSTANTS ======= */

const TARGET_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/* ======= SELECTION STATE ======= */

let _selectedForDiscard = null;
let _selectedForMove = null;
let _newlyDrawnIndex = -1;

/**
 * Sets the index of the newly drawn card for highlighting.
 * @param {number} idx
 */
export function setNewlyDrawnIndex(idx) {
  _newlyDrawnIndex = idx;
}

/**
 * Clears all selection states (call on phase/turn change).
 */
export function clearSelection() {
  _selectedForDiscard = null;
  _selectedForMove = null;
}

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Perfect Ten gameplay screen.
 * Layout: all-players bar → piles → rank tracker → local hand → self bar
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onDrawPileTap, onDiscardPileTap, onHandCardTap, onReorder }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const allPlayersEl = document.getElementById('pt-all-players');
  const pileArea = document.getElementById('pt-piles');
  const rankTrackerArea = document.getElementById('pt-rank-tracker-area');
  const handArea = document.getElementById('pt-hand-area');

  if (!pileArea || !handArea) return;

  // All-players bar — compact blocks with face-down card strips + rank count
  if (allPlayersEl) {
    renderAllPlayers(allPlayersEl, state, localPlayerIndex);
  }

  // Self info bar
  renderSelfBar(state, localPlayerIndex);

  // Piles
  const isMyDrawPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'draw';
  renderPiles(pileArea, state, isMyDrawPhase, callbacks);

  // Rank tracker for local player
  if (rankTrackerArea) {
    rankTrackerArea.innerHTML = '';
    const localHand = state.players[localPlayerIndex].hand;
    const tracker = renderRankTracker(localHand);
    rankTrackerArea.appendChild(tracker);
  }

  // Local hand — arc layout
  const isMyDiscardPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'discard';
  renderArcHand(handArea, state.players[localPlayerIndex].hand, isMyDiscardPhase, callbacks.onHandCardTap, callbacks.onReorder);
}

/* ======= ALL-PLAYERS BAR ======= */

/**
 * Renders all player blocks at the top.
 * Each block: emoji + name + face-down card strip + rank count (X/10).
 * Active turn gets gold glow. Self gets dashed border.
 */
function renderAllPlayers(container, state, localPlayerIndex) {
  container.innerHTML = '';

  state.players.forEach((player, i) => {
    if (i === localPlayerIndex) return;

    const block = document.createElement('div');
    block.className = 'game-player-block';
    block.dataset.playerIndex = String(i);
    if (i === state.currentPlayerIndex) block.classList.add('game-block-active');

    const emoji = document.createElement('span');
    emoji.className = 'game-block-emoji';
    emoji.textContent = player.emoji;

    const name = document.createElement('span');
    name.className = 'game-block-name';
    name.textContent = player.name;

    const strip = document.createElement('div');
    strip.className = 'game-card-strip';
    const count = player.hand ? player.hand.length : 5;
    for (let c = 0; c < count; c++) {
      const miniCard = document.createElement('div');
      miniCard.className = 'game-strip-card';
      strip.appendChild(miniCard);
    }

    // Rank count extra info
    const collected = getCollectedRanks(player.hand);
    const extra = document.createElement('span');
    extra.className = 'game-block-extra';
    extra.textContent = `${collected.size}/10`;

    block.appendChild(emoji);
    block.appendChild(name);
    block.appendChild(strip);
    block.appendChild(extra);
    container.appendChild(block);
  });
}

/* ======= SELF BAR ======= */

function renderSelfBar(state, localPlayerIndex) {
  const emojiEl = document.getElementById('pt-self-emoji');
  const nameEl = document.getElementById('pt-self-name');
  if (!emojiEl || !nameEl) return;
  const self = state.players[localPlayerIndex];
  if (!self) return;
  emojiEl.textContent = self.emoji;
  nameEl.textContent = self.name;
}

/* ======= RANK TRACKER ======= */

/**
 * Renders the rank tracker showing collected/missing ranks for local player.
 * @param {Array<{rank: string, suit: string}>} hand
 * @returns {HTMLElement}
 */
export function renderRankTracker(hand) {
  const collected = getCollectedRanks(hand);

  const tracker = document.createElement('div');
  tracker.className = 'pt-rank-tracker';

  TARGET_RANKS.forEach((rank) => {
    const cell = document.createElement('div');
    cell.className = 'pt-rank-cell';
    if (collected.has(rank)) {
      cell.classList.add('pt-rank-collected');
    } else {
      cell.classList.add('pt-rank-missing');
    }
    cell.textContent = rank;
    cell.setAttribute('aria-label', `Rank ${rank}: ${collected.has(rank) ? 'collected' : 'missing'}`);
    tracker.appendChild(cell);
  });

  return tracker;
}

/**
 * Renders a simplified opponent rank count.
 * @param {Array<{rank: string, suit: string}>} hand
 * @returns {HTMLElement}
 */
export function renderOpponentRankCount(hand) {
  const collected = getCollectedRanks(hand);
  const el = document.createElement('span');
  el.className = 'pt-opponent-rank-count';
  el.textContent = `${collected.size}/10`;
  return el;
}

/* ======= ARC HAND ======= */

/**
 * Renders the local player's hand in an inverted-U arc layout.
 * Two-tap discard: first tap selects, second tap confirms.
 */
function renderArcHand(container, hand, canDiscard, onCardTap, onReorder) {
  container.innerHTML = '';

  const arc = document.createElement('div');
  arc.className = 'sr-arc';

  const n = hand.length;
  const maxAngle = 30;
  const maxLift = 20;

  // Dynamic card sizing: fit all cards within container width
  const containerWidth = container.offsetWidth || 360;
  const padding = 16;
  const availableWidth = containerWidth - padding;

  let cardW = 46;
  let cardH = 64;
  let overlap = -16;
  if (n > 1) {
    const neededWidth = cardW + (n - 1) * (cardW + overlap);
    if (neededWidth > availableWidth) {
      overlap = -((n * cardW - availableWidth) / (n - 1));
      if (overlap < -30) {
        cardW = 38; cardH = 54;
        overlap = -((n * cardW - availableWidth) / (n - 1));
      }
      if (overlap < -28) {
        cardW = 32; cardH = 45;
        overlap = -((n * cardW - availableWidth) / (n - 1));
      }
    }
  }

  container.style.setProperty('--sr-card-w', `${cardW}px`);
  container.style.setProperty('--sr-card-h', `${cardH}px`);

  hand.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.dataset.handIndex = String(i);
    cardEl.classList.add('sr-arc-card');

    cardEl.style.width = `${cardW}px`;
    cardEl.style.height = `${cardH}px`;
    cardEl.style.marginLeft = i === 0 ? '0' : `${overlap}px`;

    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const angle = t * (maxAngle / 2);
    const lift = (1 - t * t) * maxLift;
    let extraLift = 0;

    // Newly drawn card highlight
    if (i === _newlyDrawnIndex) {
      cardEl.classList.add('sr-card-new');
    }

    if (canDiscard) {
      cardEl.classList.add('sr-discardable');
      cardEl.style.cursor = 'pointer';

      if (_selectedForDiscard === i) {
        cardEl.classList.add('sr-card-discard-selected');
        extraLift = 18;
      }

      cardEl.addEventListener('click', () => {
        if (_selectedForDiscard === i) {
          _selectedForDiscard = null;
          _newlyDrawnIndex = -1;
          onCardTap(i);
        } else {
          _selectedForDiscard = i;
          renderArcHand(container, hand, canDiscard, onCardTap, onReorder);
        }
      });
    } else {
      // Reorder mode: tap to select, tap another position to move
      cardEl.style.cursor = 'pointer';

      if (_selectedForMove === i) {
        cardEl.classList.add('sr-card-selected');
        extraLift = 18;
      }

      cardEl.addEventListener('click', () => {
        if (_selectedForMove === null || _selectedForMove === i) {
          _selectedForMove = _selectedForMove === i ? null : i;
          renderArcHand(container, hand, canDiscard, onCardTap, onReorder);
        } else {
          const from = _selectedForMove;
          _selectedForMove = null;
          if (onReorder) onReorder(from, i);
        }
      });
    }

    cardEl.style.transform = `translateY(${-lift - extraLift}px) rotate(${angle}deg)`;
    cardEl.style.zIndex = _selectedForDiscard === i || _selectedForMove === i ? '20' : String(i);

    arc.appendChild(cardEl);
  });

  container.appendChild(arc);
}

/* ======= PILES ======= */

/**
 * Renders draw pile and discard pile side by side.
 */
function renderPiles(container, state, isMyDrawPhase, callbacks) {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'sr-piles-row';

  // Draw pile
  const drawPileEl = document.createElement('div');
  drawPileEl.className = 'sr-pile sr-draw-pile';
  if (isMyDrawPhase) drawPileEl.classList.add('sr-pile-tappable');

  if (state.drawPile.length > 0) {
    const back = renderCardBack();
    drawPileEl.appendChild(back);
  } else {
    const empty = document.createElement('div');
    empty.className = 'sr-pile-empty';
    empty.textContent = '—';
    drawPileEl.appendChild(empty);
  }

  const drawCount = document.createElement('span');
  drawCount.className = 'sr-pile-count';
  drawCount.textContent = `Draw: ${state.drawPile.length}`;
  drawPileEl.appendChild(drawCount);

  if (isMyDrawPhase && state.drawPile.length > 0) {
    drawPileEl.addEventListener('click', () => callbacks.onDrawPileTap());
  }

  // Discard pile
  const discardPileEl = document.createElement('div');
  discardPileEl.className = 'sr-pile sr-discard-pile';
  if (isMyDrawPhase) discardPileEl.classList.add('sr-pile-tappable');

  if (state.discardPile.length > 0) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    const face = renderCardFace(topCard);
    face.style.cursor = isMyDrawPhase ? 'pointer' : 'default';
    discardPileEl.appendChild(face);
  } else {
    const empty = document.createElement('div');
    empty.className = 'sr-pile-empty';
    empty.textContent = '—';
    discardPileEl.appendChild(empty);
  }

  const discardCount = document.createElement('span');
  discardCount.className = 'sr-pile-count';
  discardCount.textContent = `Discard: ${state.discardPile.length}`;
  discardPileEl.appendChild(discardCount);

  if (isMyDrawPhase && state.discardPile.length > 0) {
    discardPileEl.addEventListener('click', () => callbacks.onDiscardPileTap());
  }

  wrapper.appendChild(drawPileEl);
  wrapper.appendChild(discardPileEl);
  container.appendChild(wrapper);
}

/* ======= WIN REVEAL ======= */

/**
 * Shows a full-screen win reveal overlay with the winner's hand and rank tracker.
 * Returns a Promise that resolves after the specified duration.
 * @param {object} winner - { name, emoji, hand }
 * @param {Array<{rank:string, suit:string}>} hand - winner's cards
 * @param {number} [duration=4000] - ms to show overlay
 * @returns {Promise<void>}
 */
export function showWinReveal(winner, hand, duration = 4000) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('pt-win-reveal');
    const emojiEl = document.getElementById('pt-reveal-emoji');
    const nameEl = document.getElementById('pt-reveal-name');
    const trackerEl = document.getElementById('pt-reveal-tracker');
    const cardsEl = document.getElementById('pt-reveal-cards');

    if (!overlay || !cardsEl) { resolve(); return; }

    // Populate header
    if (emojiEl) emojiEl.textContent = winner.emoji || '🏆';
    if (nameEl) nameEl.textContent = `${winner.name} wins!`;

    // Populate rank tracker (all green for winner)
    if (trackerEl) {
      trackerEl.innerHTML = '';
      const tracker = renderRankTracker(hand || []);
      trackerEl.appendChild(tracker);
    }

    // Rank values for sorting
    const RV = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

    // Populate face-up cards — sorted by rank
    cardsEl.innerHTML = '';
    if (hand && hand.length > 0) {
      const sorted = [...hand].sort((a, b) => (RV[a.rank] || 0) - (RV[b.rank] || 0));
      const handContainer = document.createElement('div');
      handContainer.className = 'win-reveal-hand';
      sorted.forEach((card) => {
        const cardEl = renderCardFace(card);
        cardEl.style.cursor = 'default';
        handContainer.appendChild(cardEl);
      });
      cardsEl.appendChild(handContainer);
    }

    // Show overlay
    overlay.hidden = false;

    // Auto-dismiss after duration
    setTimeout(() => {
      overlay.hidden = true;
      resolve();
    }, duration);
  });
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 */
export function renderResults(state) {
  const display = document.getElementById('pt-winner-display');
  const resultsList = document.getElementById('pt-results-list');

  if (display) {
    display.innerHTML = '';
    if (state.winnerIndex != null) {
      const winner = state.players[state.winnerIndex];
      const emojiEl = document.createElement('div');
      emojiEl.className = 'winner-emoji';
      emojiEl.textContent = winner.emoji;

      const nameEl = document.createElement('div');
      nameEl.className = 'winner-name';
      nameEl.textContent = `${winner.name} wins!`;

      const msgEl = document.createElement('div');
      msgEl.className = 'winner-bounty';
      msgEl.textContent = 'Collected all 10 ranks! 🎯';

      display.appendChild(emojiEl);
      display.appendChild(nameEl);
      display.appendChild(msgEl);

      const pot = calculatePot('perfect-ten', state);
      if (pot > 0) {
        display.appendChild(renderPotDisplay(pot));
      }
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';
    state.players.forEach((player, i) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = getPlayerMetric('perfect-ten', state, i);
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      resultsList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 */
export function renderLobbyPlayers(players) {
  const list = document.getElementById('pt-lobby-player-list');
  if (!list) return;
  list.innerHTML = '';

  players.forEach((player, index) => {
    const li = document.createElement('li');
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';
    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    list.appendChild(li);
  });
}

/* ======= READY INDICATORS ======= */

/**
 * Renders ready indicators for play again.
 */
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('pt-ready-indicators');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';

  const readySet = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers);
  const leftSet = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);

  playerNames.forEach((name, index) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readySet.has(index)) dot.classList.add('ready');
    if (leftSet.has(index)) dot.classList.add('not-ready');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = name;
    dot.appendChild(circle);
    dot.appendChild(label);
    container.appendChild(dot);
  });
}
