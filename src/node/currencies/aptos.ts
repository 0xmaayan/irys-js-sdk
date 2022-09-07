import { AptosAccount, AptosClient, CoinClient } from "aptos";
import { AptosSigner, Signer } from "arbundles/src/signing";
import BigNumber from "bignumber.js";
import { CurrencyConfig, Tx } from "../../common/types";
import BaseNodeCurrency from "../currency";
import * as SHA3 from "js-sha3";
import { Transaction_UserTransaction, TransactionPayload_EntryFunctionPayload } from "aptos/dist/generated";
// import TransactionPayload_EntryFunctionPayload from "aptos/dist/generated/models/TransactionPayload_EntryFunctionPayload"
// import axios from "axios";
// import Utils from "../../common/utils";

export default class AptosConfig extends BaseNodeCurrency {

    declare protected providerInstance?: AptosClient;
    protected accountInstance: AptosAccount;
    protected signerInstance: AptosSigner;

    constructor(config: CurrencyConfig) {
        if (typeof config.wallet === "string" && config.wallet.length === 66) config.wallet = Buffer.from(config.wallet.slice(2), "hex");
        // @ts-ignore
        config.accountInstance = new AptosAccount(config.wallet);
        super(config);
        this.base = ["aptom", 1e8];
    }

    async getProvider(): Promise<AptosClient> {
        return this.providerInstance ??= new AptosClient(this.providerUrl);
    }


    async getTx(txId: string): Promise<Tx> {

        const client = await this.getProvider();
        const tx = await client.waitForTransactionWithResult(txId, { checkSuccess: true }) as Transaction_UserTransaction;
        const payload = tx?.payload as TransactionPayload_EntryFunctionPayload;

        if (!(
            payload?.function === "0x1::coin::transfer" &&
            payload?.type_arguments[0] === "0x1::aptos_coin::AptosCoin" &&
            tx?.vm_status === "Executed successfully"
        )) {
            throw new Error(`Aptos tx ${txId} failed validation`);
        }
        const isPending = tx.type === "pending_transaction";
        return {
            to: payload.arguments[0],
            from: tx.sender,
            amount: new BigNumber(payload.arguments[1]),
            pending: isPending,
            confirmed: !isPending,
        };
    }

    ownerToAddress(owner: any): string {
        const hash = SHA3.sha3_256.create();
        hash.update(Buffer.from(owner));
        hash.update("\x00");
        return `0x${(hash.hex())}`;
    }

    async sign(data: Uint8Array): Promise<Uint8Array> {
        return await this.getSigner().sign(data);
    }

    getSigner(): Signer {
        return this.signerInstance ??= new AptosSigner(this.accountInstance.toPrivateKeyObject().privateKeyHex, this.accountInstance.toPrivateKeyObject().publicKeyHex);
    }

    async verify(pub: any, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
        return await AptosSigner.verify(pub, data, signature);
    }

    async getCurrentHeight(): Promise<BigNumber> {
        return new BigNumber((await (await this.getProvider()).client.blocks.httpRequest.request({ method: "GET", url: "/" }) as { block_height: string; }).block_height);

    }

    async getFee(amount: BigNumber.Value, to?: string): Promise<BigNumber> {
        const client = await this.getProvider();
        const payload = new CoinClient(client).transactionBuilder.buildTransactionPayload(
            "0x1::coin::transfer",
            ["0x1::aptos_coin::AptosCoin"],
            [to ?? "0x149f7dc9c8e43c14ab46d3a6b62cfe84d67668f764277411f98732bf6718acf9", new BigNumber(amount).toNumber()],
        );

        const rawTransaction = await client.generateRawTransaction(this.accountInstance.address(), payload);
        const simulationResult = await client.simulateTransaction(this.accountInstance, rawTransaction);
        return new BigNumber(simulationResult?.[0].gas_unit_price).multipliedBy(simulationResult?.[0].gas_used);
        // const est = await provider.client.transactions.estimateGasPrice();
        // return new BigNumber(est.gas_estimate/* (await (await this.getProvider()).client.transactions.estimateGasPrice()).gas_estimate */); // * by gas limit (for upper limit)
    }

    async sendTx(data: any): Promise<string | undefined> {
        return (await (await (this.getProvider())).submitSignedBCSTransaction(data)).hash;
    }

    async createTx(amount: BigNumber.Value, to: string, _fee?: string): Promise<{ txId: string; tx: any; }> {
        const client = await this.getProvider();
        const payload = new CoinClient(client).transactionBuilder.buildTransactionPayload(
            "0x1::coin::transfer",
            ["0x1::aptos_coin::AptosCoin"],
            [to, new BigNumber(amount).toNumber()],
        );

        const rawTransaction = await client.generateRawTransaction(this.accountInstance.address(), payload);
        const bcsTxn = AptosClient.generateBCSTransaction(this.accountInstance, rawTransaction);

        return { txId: undefined, tx: bcsTxn };
    }

    getPublicKey(): string | Buffer {
        return Buffer.from(this.accountInstance.toPrivateKeyObject().publicKeyHex.slice(2), "hex");
    }

};