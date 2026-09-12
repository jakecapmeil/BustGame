/**
 * BUST — @bust/core public API.
 *
 * The DOM-free, platform-agnostic heart of the game: pure rules, the neural
 * bot, scoring, canvas drawing and a generic input contract. Every shell
 * (web, ios) imports from here and supplies its own platform services —
 * storage, audio, networking transport, input translation, canvas surface.
 */

// Rules model + mode data (pure).
export {
  createGame, applyMove, applyMoveFast, isLegalMove, legalMoves, legalPlacements,
  scores, winnersOf, openingMask, blockingStarts, neighbors,
  sameTeam, outDegree, edgeSides, idxOf, isBlocked,
  PHASE_PLACE, PHASE_PLAY, PHASE_OVER, EMPTY, MAX_BALLS,
} from './engine.js';

export {
  MODES, MODE_ORDER, MAX_SEATS, modeFor, buildSetup, buildPartySetup,
  describeSetup, minBoardFor,
} from './modes.js';

// Computer opponents.
export {
  DIFFICULTIES, DIFFICULTY_ORDER, NEEDS_NET, evaluate,
  chooseMove, chooseMoveAsync, warmNeural, difficultyLabel,
} from './ai.js';
export { BustNet, loadNet, encode, N_PLANES } from './nn.js';
export { NeuralBot, NEURAL_PRESETS } from './nn-bot.js';

// Ranked ladder + scoring.
export {
  RANKS, rankIndexFor, rankFor, nextRank, progressToNext, floorFor,
  matchmake, matchmakeSeeded, placements, scoreResult, applyDelta,
  loadProfile, saveProfile, recordMatch,
} from './rank.js';

// Canvas rendering (DOM-free — the shell supplies the context + services).
export {
  BoardAnimator, PLAYER_COLORS, BOARD_SKIN, setBoardSkin,
  computeLayout, cellCentre, hitTest, drawBoard,
} from './render.js';

// Generic input contract every shell speaks.
export { POINTER, ACTION, tileFromPointer } from './input.js';