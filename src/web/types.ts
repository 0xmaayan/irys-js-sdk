import type { Currency } from "../common/types.js";

export interface WebCurrency extends Currency {
  getPublicKey(): Promise<string | Buffer>;
  ready(): Promise<void>;
  inheritsRPC: boolean;
}
