// ── Engine domain ──────────────────────────────────────────
export type Phase = 'waiting' | 'running' | 'crashed';

export interface ActiveBet {
  betId: string;
  apiKey: string;
  amount: number;
  autoCashOutAt: number | null;
  placedAt: Date;
  balanceAtPlacement: number;   // used to populate bet:lost.balance
}

// ── Public WebSocket payloads (client-facing, no apiKey) ──
export type RejectReason =
  | 'betting_closed'
  | 'already_has_bet'
  | 'no_active_bet'
  | 'not_running'
  | 'insufficient_balance'
  | 'invalid_auto_cashout'
  | 'invalid_payload';

export interface RoundStateEvent {
  phase: Phase;
  roundId: string;
  startedAt: string | null;
  endsAt: string | null;
  currentMultiplier: number;
  crashPoint: number | null;
  yourBet: {
    amount: number;
    autoCashOutAt: number | null;
    status: 'placed' | 'cashedOut' | 'lost';
  } | null;
  playerCount: number;
}

export interface RoundWaitingEvent {
  roundId: string;
  endsAt: string;
  playerCount: 0;
}

export interface RoundStartEvent {
  roundId: string;
  startedAt: string;
  playerCount: number;
}

export interface RoundTickEvent {
  roundId: string;
  multiplier: number;
  elapsedMs: number;
}

export interface RoundCrashEvent {
  roundId: string;
  crashPoint: number;
  playerCount: number;
}

export interface BetPlacedEvent {
  betId: string;
  roundId: string;
  amount: number;
  autoCashOutAt: number | null;
  balance: number;
}

export interface BetCashedOutEvent {
  betId: string;
  multiplier: number;
  winAmount: number;
  profit: number;
  balance: number;
}

export interface BetLostEvent {
  betId: string;
  crashPoint: number;
  balance: number;
}

export interface BetRejectedEvent {
  reason: RejectReason;
  message: string;
}

// ── REST response shapes ─────────────────────────────────
export interface BalanceResponse {
  balance: number;
}

export interface RecentRound {
  roundId: string;
  crashPoint: number;
  crashedAt: string;
}

export interface RecentRoundsResponse {
  rounds: RecentRound[];
}

// Helper: convert internal numeric round id → public string
export const publicRoundId = (id: number): string => `round_${id}`;
