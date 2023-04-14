import type { BundlrConfig } from "common/types";
import Api from "../common/api.js";
import Bundlr from "../common/bundlr.js";
import Fund from "../common/fund.js";
import Uploader from "../common/upload.js";
import Utils from "../common/utils.js";
import getCurrency from "./currencies/index.js";
// import WebFund from "./fund.js";
import type { WebCurrency } from "./types.js";
import * as arbundles from "./utils.js";

export default class WebBundlr extends Bundlr {
  public currencyConfig: WebCurrency;

  constructor(url: string, currency: string, provider?: any, config?: BundlrConfig) {
    const parsed = new URL(url);
    // @ts-expect-error private type issue
    super(parsed, arbundles);

    this.api = new Api({
      protocol: parsed.protocol.slice(0, -1),
      port: parsed.port,
      host: parsed.hostname,
      timeout: config?.timeout ?? 100000,
      headers: config?.headers,
    });
    this.currencyConfig = getCurrency(this, currency.toLowerCase(), provider, config?.providerUrl, config?.contractAddress);
    this.api = new Api({ protocol: parsed.protocol.slice(0, -1), port: parsed.port, host: parsed.hostname, timeout: config?.timeout ?? 100000 });
    this.currency = this.currencyConfig.name;
    if (parsed.host === "devnet.bundlr.network" && !(config?.providerUrl || this.currencyConfig.inheritsRPC))
      throw new Error(`Using ${parsed.host} requires a dev/testnet RPC to be configured! see https://docs.bundlr.network/sdk/using-devnet`);
    this.utils = new Utils(this.api, this.currency, this.currencyConfig);
    this.uploader = new Uploader(this.api, this.utils, this.currency, this.currencyConfig);
    this.funder = new Fund(this.utils);
    this.address = "Please run `await bundlr.ready()`";
  }
}
