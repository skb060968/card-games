/**
 * Simple Rummy — UI Module
 *
 * Renders gameplay screen: fan hand, draw/discard piles,
 * opponent hands, turn indicator, win display.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Simple Rummy gameplay screen.
 * Layout: players bar (all players) → current turn info → piles → turn indicator → local hand
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onDrawPileTap, onDiscardPileTap, onHandCardTap }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const currentTurnEl = document.getElementById('sr-current-turn');
  const playersBar = document.getElementById('sr-players-bar');
  const pileArea = document.getElementById('sr-piles');
  const handArea = document.getElementById('sr-hand-area');
  const turnIndicator = document.getElementById('sr-turn-indicator');

  if (!pileArea || !handArea) return;

  // Players bar — compact chips for all players
  if (playersBar) {
    renderPlayersBar(playersBar, state.players, state.currentPlayerIndex, localPlayerIndex);
  }

  // Current turn — show active player info + their face-down hand strip (if not local)
  if (currentTurnEl) {
    currentTurnEl.innerHTML = '';
    const current = state.players[state.currentPlayerIndex];
    const isMe = state.currentPlayerIndex === localPlayerIndex;

    const header = document.createElement('div');
    header.className = 'sr-ct-header';

    const emoji = document.createElement('span');
    emoji.className = 'sr-ct-emoji';
    emoji.textContent = current.emoji;

    const name = document.createElement('span');
    name.className = 'sr-ct-name';
    name.textContent = isMe ? 'Your Turn' : `${current.name}'s Turn`;

    header.appendChild(emoji);
    header.appendChild(name);
    currentTurnEl.appendChild(header);

    // Show active player's hand as flat face-down strip (only for opponents)
    if (!isMe) {
      const strip = document.createElement('div');
      strip.className = 'sr-opponent-hand-strip';
      const count = current.hand.length;
      for (let c = 0; c < count; c++) {
        const back = renderCardBack();
        back.classList.add('sr-strip-card');
        strip.appendChild(back);
      }
      currentTurnEl.appendChild(strip);
    }
  }

  // Piles
  const isMyDrawPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'draw';
  renderPiles(pileArea, state, isMyDrawPhase, callbacks);

  // Turn indicator
  if (turnIndicator) {
    if (state.currentPlayerIndex === localPlayerIndex) {
      turnIndicator.textContent = state.turnPhase === 'draw'
        ? '👆 Pick a card from draw or discard pile'
        : '👆 Tap a card to discard';
    } else {
      turnIndicator.textContent = '';
    }
  }

  // Local hand — arc/inverted-U layout
  const isMyDiscardPhase = state.currentPlayerIndex === localPlayerIndex && state.turnPhase === 'discard';
  renderArcHand(handArea, state.players[localPlayerIndex].hand, isMyDiscardPhase, callbacks.onHandCardTap, callbacks.onReorder);
}

/**
 * Renders a compact players bar showing all players.
 * Each player shows emoji + name + card count. Active turn gets highlight.
 */
function renderPlayersBar(container, players, currentPlayerIndex, localPlayerIndex) {
  container.innerHTML = '';

  players.forEach((player, i) => {
    const slot = document.createElement('div');
    slot.className = 'sr-player-chip';
    if (i === currentPlayerIndex) slot.classList.add('sr-chip-active');
    if (i === localPlayerIndex) slot.classList.add('sr-chip-me');

    const emoji = document.createElement('span');
    emoji.className = 'sr-chip-emoji';
    emoji.textContent = player.emoji;

    const info = document.createElement('span');
    info.className = 'sr-chip-info';
    const displayName = i === localPlayerIndex ? 'You' : player.name;
    info.textContent = `${displayName} (${player.hand.length})`;

    slot.appendChild(emoji);
    slot.appendChild(info);
    container.appendChild(slot);
  });
}

/* ======= ARC HAND (Inverted-U) ======= */

// Track selected card index for reordering or discard confirmation
let _selectedForMove = null;
let _selectedForDiscard = null;
// Track the index of the newly drawn card
let _newlyDrawnIndex = -1;

/**
 * Sets the index of the newly drawn card for highlighting.
 * @param {number} idx
 */
export function setNewlyDrawnIndex(idx) {
  _newlyDrawnIndex = idx;
}

/**
 * Renders the local player's hand in an inverted-U arc layout.
 *
 * Modes:
 * - Discard phase (canDiscard=true): first tap selects card (lifts + gold glow),
 *   second tap on same card confirms discard, tapping different card switches selection.
 * - Otherwise: tap to select for reorder, tap another position to move.
 *
 * @param {HTMLElement} container
 * @param {Array<{rank: string, suit: string}>} hand
 * @param {boolean} canDiscard
 * @param {Function} onCardTap - callback(handIndex) for confirmed discard
 * @param {Function} [onReorder] - callback(fromIndex, toIndex) for rearranging
 */
export function renderArcHand(container, hand, canDiscard, onCardTap, onReorder) {
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

    // Newly drawn card highlight (green glow)
    if (i === _newlyDrawnIndex) {
      cardEl.classList.add('sr-card-new');
    }

    if (canDiscard) {
      // Discard mode: two-tap confirm
      cardEl.classList.add('sr-discardable');
      cardEl.style.cursor = 'pointer';

      if (_selectedForDiscard === i) {
        cardEl.classList.add('sr-card-discard-selected');
        extraLift = 18;
      }

      cardEl.addEventListener('click', () => {
        if (_selectedForDiscard === i) {
          // Second tap — confirm discard
          _selectedForDiscard = null;
          _newlyDrawnIndex = -1;
          onCardTap(i);
        } else {
          // First tap or switch selection
          _selectedForDiscard = i;
          renderArcHand(container, hand, canDiscard, onCardTap, onReorder);
        }
      });
    } else {
      // Reorder mode
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

/**
 * Clears all selection states (call on phase/turn change).
 */
export function clearSelection() {
  _selectedForMove = null;
  _selectedForDiscard = null;
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

/* ======= WIN DISPLAY ======= */

/**
 * Renders the winning hand grouped into sets/sequences.
 * @param {Array<Array<{rank: string, suit: string}>>} groups
 * @param {{name: string, emoji: string}} winner
 */
export function renderWinDisplay(groups, winner) {
  const display = document.getElementById('sr-winner-display');
  if (!display) return;

  display.innerHTML = '';

  const emojiEl = document.createElement('div');
  emojiEl.className = 'winner-emoji';
  emojiEl.textContent = winner.emoji;

  const nameEl = document.createElement('div');
  nameEl.className = 'winner-name';
  nameEl.textContent = `${winner.name} wins!`;

  display.appendChild(emojiEl);
  display.appendChild(nameEl);

  // Show grouped cards
  const groupsContainer = document.createElement('div');
  groupsContainer.className = 'sr-win-groups';

  groups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'sr-win-group';

    group.forEach((card) => {
      const cardEl = renderCardFace(card);
      cardEl.style.cursor = 'default';
      groupEl.appendChild(cardEl);
    });

    groupsContainer.appendChild(groupEl);
  });

  display.appendChild(groupsContainer);
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 */
export function renderResults(state) {
  const display = document.getElementById('sr-winner-display');
  const bountyList = document.getElementById('sr-results-list');

  if (display) {
    display.innerHTML = '';
    if (state.winnerIndex != null && state.winGroups) {
      renderWinDisplay(state.winGroups, state.players[state.winnerIndex]);
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (bountyList) {
    bountyList.innerHTML = '';
    state.players.forEach((player) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = `🃏 ${player.hand.length} cards`;
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      bountyList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 */
export function renderLobbyPlayers(players) {
  const list = document.getElementById('sr-lobby-player-list');
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

export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('sr-ready-indicators');
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
