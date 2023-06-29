import { PromisePool } from "@supercharge/promise-pool";
import type { DataItem, JWKInterface } from "arbundles";
import { ArweaveSigner } from "arbundles";
import retry from "async-retry";
import type { AxiosResponse } from "axios";
import base64url from "base64url";
import Crypto from "crypto";
import type { Readable } from "stream";
import type Api from "./api";
import { ChunkingUploader } from "./chunkingUploader";
import type {
  Arbundles,
  CreateAndUploadOptions,
  Currency,
  IrysTransactonCtor,
  Manifest,
  UploadOptions,
  UploadReceipt,
  UploadResponse,
} from "./types";
import type Utils from "./utils";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const CHUNKING_THRESHOLD = 50_000_000;
// eslint-disable-next-line @typescript-eslint/naming-convention
export default class Uploader {
  protected readonly api: Api;
  protected currency: string;
  protected currencyConfig: Currency;
  protected utils: Utils;
  protected contentTypeOverride: string | undefined;
  protected forceUseChunking: boolean | undefined;
  protected arbundles: Arbundles;
  protected irysTransaction: IrysTransactonCtor;

  constructor(api: Api, utils: Utils, currency: string, currencyConfig: Currency, irysTransaction: IrysTransactonCtor) {
    this.api = api;
    this.currency = currency;
    this.currencyConfig = currencyConfig;
    this.arbundles = this.currencyConfig.irys.arbundles;
    this.utils = utils;
    this.irysTransaction = irysTransaction;
  }

  /**
   * Uploads a given transaction to the bundler
   * @param transaction
   */

  uploadTransaction(
    transaction: DataItem | Readable | Buffer,
    opts: UploadOptions & { getReceiptSignature: true },
  ): Promise<AxiosResponse<UploadReceipt>>;
  uploadTransaction(transaction: DataItem | Readable | Buffer, opts?: UploadOptions): Promise<AxiosResponse<UploadResponse>>;

  public async uploadTransaction(transaction: DataItem | Readable | Buffer, opts?: UploadOptions): Promise<AxiosResponse<UploadResponse>> {
    let res: AxiosResponse<UploadResponse>;
    const isDataItem = this.arbundles.DataItem.isDataItem(transaction);
    if (this.forceUseChunking || (isDataItem && transaction.getRaw().length >= CHUNKING_THRESHOLD) || !isDataItem) {
      res = await this.chunkedUploader.uploadTransaction(isDataItem ? transaction.getRaw() : transaction, opts);
    } else {
      const { protocol, host, port, timeout, headers: confHeaders } = this.api.getConfig();
      const headers = { "Content-Type": "application/octet-stream", ...confHeaders };
      if (opts?.getReceiptSignature === true) headers["x-proof-type"] = "receipt";
      res = await this.api.post(`${protocol}://${host}:${port}/tx/${this.currency}`, transaction.getRaw(), {
        headers: headers,
        timeout,
        maxBodyLength: Infinity,
      });
      if (res.status === 201) {
        if (opts?.getReceiptSignature === true) {
          throw new Error(res.data as any as string);
        }
        res.data = { id: transaction.id };
      }
    }
    switch (res.status) {
      case 402:
        throw new Error("Not enough funds to send data");
      default:
        if (res.status >= 400) {
          throw new Error(`whilst uploading Irys transaction: ${res.status} ${res.statusText}`);
        }
    }
    if (opts?.getReceiptSignature) {
      res.data.verify = async (): Promise<boolean> => this.utils.verifyReceipt(res.data as UploadReceipt);
    }
    return res;
  }

  public async uploadData(data: string | Buffer | Readable, opts?: CreateAndUploadOptions): Promise<UploadResponse> {
    if (typeof data === "string") {
      data = Buffer.from(data);
    }
    if (Buffer.isBuffer(data)) {
      if (data.length <= CHUNKING_THRESHOLD) {
        const dataItem = this.arbundles.createData(data, this.currencyConfig.getSigner(), {
          ...opts,
          anchor: opts?.anchor ?? Crypto.randomBytes(32).toString("base64").slice(0, 32),
        });
        await dataItem.sign(this.currencyConfig.getSigner());
        return (await this.uploadTransaction(dataItem, { ...opts?.upload })).data;
      }
    }
    return (await this.chunkedUploader.uploadData(data, opts)).data;
  }

  // concurrently uploads transactions
  public async concurrentUploader(
    data: (DataItem | Buffer | Readable)[],
    opts?: {
      concurrency?: number;
      resultProcessor?: (res: any) => Promise<any>;
      logFunction?: (log: string) => Promise<any>;
      itemOptions?: CreateAndUploadOptions;
    },
  ): Promise<{ errors: any[]; results: any[] }> {
    const errors = [] as Error[];
    const logFn = opts?.logFunction
      ? opts?.logFunction
      : async (_: any): Promise<any> => {
          return;
        };
    const concurrency = opts?.concurrency ?? 5;
    const results = (await PromisePool.for(data)
      .withConcurrency(concurrency >= 1 ? concurrency : 5)
      .handleError(async (error, _) => {
        errors.push(error);
        if (error.message === "Not enough funds to send data") {
          throw error;
        }
      })
      .process(async (item, i, _) => {
        await retry(
          async (bail) => {
            try {
              const res = await this.processItem(item, opts?.itemOptions);
              if (i % concurrency == 0) {
                await logFn(`Processed ${i} Items`);
              }
              if (opts?.resultProcessor) {
                return await opts.resultProcessor({ item, res, i });
              } else {
                return { item, res, i };
              }
            } catch (e: any) {
              if (e?.message === "Not enough funds to send data") {
                bail(e);
              }
              throw e;
            }
          },
          { retries: 3, minTimeout: 1000, maxTimeout: 10_000 },
        );
      })) as any;
    return { errors, results: results.results };
  }

  protected async processItem(data: string | Buffer | Readable | DataItem, opts?: CreateAndUploadOptions): Promise<any> {
    if (this.arbundles.DataItem.isDataItem(data)) {
      return this.uploadTransaction(data, { ...opts?.upload });
    }
    return this.uploadData(data, opts);
  }

  /**
   * geneates a manifest JSON object
   * @param config.items mapping of logical paths to item IDs
   * @param config.indexFile optional logical path of the index file for the manifest
   * @returns
   */
  public async generateManifest(config: { items: Map<string, string>; indexFile?: string }): Promise<Manifest> {
    const { items, indexFile } = config;
    const manifest: Manifest = {
      manifest: "arweave/paths",
      version: "0.1.0",
      paths: {},
    };
    if (indexFile) {
      if (!items.has(indexFile)) {
        throw new Error(`Unable to access item: ${indexFile}`);
      }
      manifest.index = { path: indexFile };
    }
    for (const [k, v] of items.entries()) {
      // @ts-expect-error constant index type
      manifest.paths[k] = { id: v };
    }
    return manifest;
  }

  get chunkedUploader(): ChunkingUploader {
    return new ChunkingUploader(this.currencyConfig, this.api);
  }

  set useChunking(state: boolean) {
    if (typeof state === "boolean") {
      this.forceUseChunking = state;
    }
  }

  set contentType(type: string) {
    // const fullType = mime.contentType(type)
    // if(!fullType){
    //     throw new Error("Invali")
    // }
    this.contentTypeOverride = type;
  }
  // uploadTransaction(
  //   transaction: DataItem | Readable | Buffer,
  //   opts: UploadOptions & { getReceiptSignature: true },
  // ): Promise<AxiosResponse<UploadReceipt>>;
  // uploadTransaction(transaction: DataItem | Readable | Buffer, opts?: UploadOptions): Promise<AxiosResponse<UploadResponse>>;

  uploadMany(
    transactions: (DataItem | Buffer | string)[],
    opts: UploadOptions & { getReceiptSignature: true },
  ): Promise<AxiosResponse<UploadReceipt> & { ephemeralKey: JWKInterface; ephemeralAddress: string; txs: string[] }>;
  uploadMany(
    transactions: (DataItem | Buffer)[],
    opts?: UploadOptions,
  ): Promise<AxiosResponse<UploadResponse> & { ephemeralKey: JWKInterface; ephemeralAddress: string; txs: string[] }>;

  public async uploadMany(
    transactions: (DataItem | Buffer)[],
    opts?: UploadOptions,
  ): Promise<AxiosResponse<UploadResponse> & { ephemeralKey: JWKInterface; ephemeralAddress: string; txs: string[] }> {
    const ephemeralKey = await this.arbundles.getCryptoDriver().generateJWK();
    const ephemeralSigner = new ArweaveSigner(ephemeralKey);
    const txs = transactions.map((tx) => (this.arbundles.DataItem.isDataItem(tx) ? tx : this.arbundles.createData(tx, ephemeralSigner)));
    const bundle = await this.arbundles.bundleAndSignData(txs, ephemeralSigner);

    // upload bundle with bundle specific tags, use actual signer for this.
    const tx = this.arbundles.createData(bundle.getRaw(), this.currencyConfig.getSigner(), {
      tags: [
        { name: "Bundle-Format", value: "binary" },
        { name: "Bundle-Version", value: "2.0.0" },
      ],
    });
    await tx.sign(this.currencyConfig.getSigner());

    const res = await this.uploadTransaction(tx, opts);
    const ephemeralAddress = base64url(
      Buffer.from(await this.arbundles.getCryptoDriver().hash(base64url.toBuffer(base64url(ephemeralSigner.publicKey)))),
    );

    return { ...res, txs: bundle.getIds(), ephemeralKey, ephemeralAddress };
  }
}
