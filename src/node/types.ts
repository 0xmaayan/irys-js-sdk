import type { Currency } from "../common/types.js";
export interface NodeCurrency extends Currency {
  getPublicKey(): string | Buffer;
}
