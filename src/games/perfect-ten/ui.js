/**
 * Perfect Ten — UI Module
 *
 * Renders gameplay screen: players bar, draw/discard piles,
 * rank tracker, local hand with arc layout, lobby, results.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { getCollectedRanks } from './engine.js';

/* ======= CONSTANTS ======= */

const TARGET_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/* ======= SELECTION STATE ======= */

let _selectedForDiscard = null;
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
}

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Perfect Ten gameplay screen.
 * Layout: players bar → current turn info → piles → rank tracker → local hand
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onDrawPileTap, onDiscardPileTap, onHandCardTap, onReorder }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const currentTurnEl = document.getElementById('pt-current-turn');
  const playersBar = document.getElementById('pt-players-bar');
  const pileArea = document.getElementById('pt-piles');
  const rankTrackerArea = document.getElementById('pt-rank-tracker-area');
  const handArea = document.getElementById('pt-hand-area');

  if (!pileArea || !handArea) return;

  // Players bar — compact chips for all players
  if (playersBar) {
    renderPlayersBar(playersBar, state, localPlayerIndex);
  }

  // Opponent hand strip — show active player's face-down hand when not local player's turn
  if (currentTurnEl) {
    currentTurnEl.innerHTML = '';
    const current = state.players[state.currentPlayerIndex];
    const isMe = state.currentPlayerIndex === localPlayerIndex;

    if (!isMe && current) {
      const header = document.createElement('div');
      header.className = 'sr-ct-header';

      const emoji = document.createElement('span');
      emoji.className = 'sr-ct-emoji';
      emoji.textContent = current.emoji;

      const name = document.createElement('span');
      name.className = 'sr-ct-name';
      name.textContent = `${current.name}'s Turn`;

      header.appendChild(emoji);
      header.appendChild(name);
      currentTurnEl.appendChild(header);

      const count = current.hand ? current.hand.length : 5;
      if (count > 0) {
        const strip = document.createElement('div');
        strip.className = 'sr-opponent-hand-strip';
        for (let c = 0; c < count; c++) {
          const back = renderCardBack();
          back.classList.add('sr-strip-card');
          strip.appendChild(back);
        }
        currentTurnEl.appendChild(strip);
      }
    }
  }

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

/* ======= PLAYERS BAR ======= */

/**
 * Renders a compact players bar showing all players.
 * Each player shows emoji + name + rank count. Active turn gets highlight.
 */
function renderPlayersBar(container, state, localPlayerIndex) {
  container.innerHTML = '';

  state.players.forEach((player, i) => {
    const slot = document.createElement('div');
    slot.className = 'sr-player-chip';
    if (i === state.currentPlayerIndex) slot.classList.add('sr-chip-active');
    if (i === localPlayerIndex) slot.classList.add('sr-chip-me');

    const emoji = document.createElement('span');
    emoji.className = 'sr-chip-emoji';
    emoji.textContent = player.emoji;

    const info = document.createElement('span');
    info.className = 'sr-chip-info';
    const displayName = i === localPlayerIndex ? 'You' : player.name;

    // Show rank count for opponents
    if (i !== localPlayerIndex) {
      const collected = getCollectedRanks(player.hand);
      info.textContent = `${displayName} (${collected.size}/10)`;
    } else {
      const collected = getCollectedRanks(player.hand);
      info.textContent = `${displayName} (${collected.size}/10)`;
    }

    slot.appendChild(emoji);
    slot.appendChild(info);
    container.appendChild(slot);
  });
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

  hand.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.dataset.handIndex = String(i);
    cardEl.classList.add('sr-arc-card');

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
      cardEl.style.cursor = 'pointer';

      cardEl.addEventListener('click', () => {
        // Reorder mode — not critical for PT but keeps consistency
        if (onReorder) {
          // Simple: no reorder for now, just visual
        }
      });
    }

    cardEl.style.transform = `translateY(${-lift - extraLift}px) rotate(${angle}deg)`;
    cardEl.style.zIndex = _selectedForDiscard === i ? '20' : String(i);

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
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';
    state.players.forEach((player) => {
      const collected = getCollectedRanks(player.hand);
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = `${collected.size}/10 ranks`;
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
