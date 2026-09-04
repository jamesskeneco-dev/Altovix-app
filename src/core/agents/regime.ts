import { S } from "../llm/schema.ts";
import type { AgentSpec } from "./types.ts";
import { HOUSE_RULES } from "./types.ts";
import { header, macroBlock, regimeDirection } from "./common.ts";

export interface RegimeOut {
  regime: "RISK_ON" | "NEUTRAL" | "RISK_OFF";
  confidence: number;
  horizonDays: number;
  volatilityRegime: "CALM" | "NORMAL" | "STRESSED";
  volCeiling: number;
  drivers: Array<{ factor: string; reading: string; leans: "RISK_ON" | "RISK_OFF" | "MIXED" }>;
  breadthRead: string;
  whatWouldChangeMyMind: string;
  summary: string;
}

export const regimeAgent: AgentSpec<RegimeOut> = {
  name: "regime",
  title: "Market Regime",
  purpose: "Reads the macro tape and calls risk-on, neutral or risk-off with a scoreable horizon.",
  toolName: "submit_regime_read",
  toolDescription: "Submit the market regime assessment.",
  temperature: 0.2,
  maxTokens: 1600,
  schema: S.obj({
    regime: S.enum("Overall risk posture implied by the tape.", ["RISK_ON", "NEUTRAL", "RISK_OFF"]),
    confidence: S.confidence(),
    horizonDays: S.int("Trading days this read is meant to hold for.", 5, 63),
    volatilityRegime: S.enum("Current volatility environment.", ["CALM", "NORMAL", "STRESSED"]),
    volCeiling: S.num("Annualised realised vol you expect SPY to stay under over the horizon, e.g. 0.18.", 0.03, 1.5),
    drivers: S.arr("The specific readings driving the call.", S.obj({
      factor: S.str("Which input, e.g. 'SPY vs 200d', 'HYG/LQD credit', '^VIX level'."),
      reading: S.str("The actual number or state you are reading, quoted from the table."),
      leans: S.enum("Which way this factor points.", ["RISK_ON", "RISK_OFF", "MIXED"]),
    }), 3, 8),
    breadthRead: S.str("What the spread between SPY, QQQ and IWM says about participation."),
    whatWouldChangeMyMind: S.str("A specific, observable reading that would flip this call."),
    summary: S.str("Two or three sentences a portfolio manager could act on."),
  }),
  system: `${HOUSE_RULES}

YOUR ROLE: Market Regime Agent. You run first and set the weather for everyone after you.

You are given daily readings for broad indices (SPY, QQQ, IWM), duration (TLT), credit
(HYG vs LQD), the dollar (UUP), oil (USO), gold (GLD) and volatility (^VIX). Read them as a
system: credit leading equities down, small caps lagging badly, vol expanding while price
holds, and dollar strength with falling oil are all classic tells worth more than any single
index return.

Anchor on base rates. Equities drift up most 21-day windows, so RISK_OFF is the higher bar
and needs corroboration across at least two independent factors, not one scary print. Say
NEUTRAL when the tape is genuinely mixed - it is a real answer and it scores honestly.`,
  buildUser(ctx) {
    return [
      header(ctx),
      "",
      macroBlock(ctx),
      "",
      `Call the regime for the next 5-63 trading days. The candidate under review is ${ctx.symbol}, but judge the market, not the stock.`,
    ].join("\n");
  },
  claims(out) {
    return [
      {
        agent: "regime",
        claimKind: "REGIME_DIRECTION",
        subject: "SPY",
        statement: `Regime ${out.regime}: SPY ${regimeDirection(out.regime) === "UP" ? "rises" : regimeDirection(out.regime) === "DOWN" ? "falls" : "stays within +/-3%"} over ${out.horizonDays} trading days.`,
        direction: regimeDirection(out.regime),
        threshold: 0.03,
        confidence: out.confidence,
        horizonDays: out.horizonDays,
        resolver: "MECHANICAL",
      },
      {
        agent: "regime",
        claimKind: "VOL_BAND",
        subject: "SPY",
        statement: `Volatility ${out.volatilityRegime}: SPY realised vol stays under ${out.volCeiling} over ${out.horizonDays} trading days.`,
        direction: "TRUE",
        threshold: out.volCeiling,
        confidence: out.confidence,
        horizonDays: out.horizonDays,
        resolver: "MECHANICAL",
      },
    ];
  },
};
