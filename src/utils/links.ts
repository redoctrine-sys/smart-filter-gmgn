import { env } from "../config/env.js";

export function trojanLink(ca: string): string {
  const ref = env.TROJAN_REFCODE;
  if (ref) return `https://t.me/solana_trojanbot?start=r-${ref}-${ca}`;
  return `https://t.me/solana_trojanbot?start=${ca}`;
}

export function jupiterLink(ca: string): string {
  return `${env.JUPITER_BASE_URL}${ca}`;
}

export function gmgnTokenLink(ca: string): string {
  return `https://gmgn.ai/sol/token/${ca}`;
}

export function dexscreenerLink(ca: string): string {
  return `https://dexscreener.com/solana/${ca}`;
}

export function solscanLink(ca: string): string {
  return `https://solscan.io/token/${ca}`;
}
