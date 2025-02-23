// packages/plugin-solana/src/keypairUtils.ts

import { Keypair, PublicKey } from "@solana/web3.js";
import { DeriveKeyProvider, TEEMode } from "@elizaos/plugin-tee";
import bs58 from "bs58";
import { IAgentRuntime, elizaLogger } from "@elizaos/core";

export interface KeypairResult {
    keypair?: Keypair;
    publicKey?: PublicKey;
}

/**
 * @param runtime The agent runtime
 * @param requirePrivateKey Whether to return a full keypair (true) or just public key (false)
 * @returns KeypairResult containing either keypair or public key
 */
export async function getWalletKey(
    runtime: IAgentRuntime,
    requirePrivateKey: boolean = true
): Promise<KeypairResult> {
    const teeMode = runtime.getSetting("TEE_MODE") || TEEMode.OFF;

    if (teeMode !== TEEMode.OFF) {
        const walletSecretSalt = runtime.getSetting("WALLET_SECRET_SALT");
        if (!walletSecretSalt) {
            throw new Error(
                "WALLET_SECRET_SALT required when TEE_MODE is enabled"
            );
        }

        const deriveKeyProvider = new DeriveKeyProvider(teeMode);
        const deriveKeyResult = await deriveKeyProvider.deriveEd25519Keypair(
            "/",
            walletSecretSalt,
            runtime.agentId
        );

        return requirePrivateKey
            ? { keypair: deriveKeyResult.keypair }
            : { publicKey: deriveKeyResult.keypair.publicKey };
    }

    // TEE mode is OFF
    if (requirePrivateKey) {
        // Try runtime settings first
        let privateKeyString =
            runtime.getSetting("SOLANA_PRIVATE_KEY") ??
            runtime.getSetting("WALLET_PRIVATE_KEY");

        elizaLogger.debug("Environment check:", {
            processEnvSolanaKey: process.env.SOLANA_PRIVATE_KEY?.substring(0, 10) + '...',
            processEnvWalletKey: process.env.WALLET_PRIVATE_KEY?.substring(0, 10) + '...',
            runtimeSolanaKey: runtime.getSetting("SOLANA_PRIVATE_KEY")?.substring(0, 10) + '...',
            runtimeWalletKey: runtime.getSetting("WALLET_PRIVATE_KEY")?.substring(0, 10) + '...',
            hasKey: !!privateKeyString,
            teeMode,
            requirePrivateKey
        });

        // If not found in runtime settings, try environment variables directly
        if (!privateKeyString) {
            privateKeyString = process.env.SOLANA_PRIVATE_KEY ?? process.env.WALLET_PRIVATE_KEY ?? null;
            if (privateKeyString) {
                elizaLogger.info("Using private key from environment variables");
            }
        }

        if (!privateKeyString) {
            throw new Error("Private key not found in settings or environment variables");
        }

        elizaLogger.debug("Attempting to decode private key:", {
            keyLength: privateKeyString.length,
            firstFewChars: privateKeyString.substring(0, 10) + '...',
            lastFewChars: '...' + privateKeyString.substring(privateKeyString.length - 10)
        });

        try {
            // First try base58
            elizaLogger.debug("Attempting base58 decode...");
            const secretKey = bs58.decode(privateKeyString);
            elizaLogger.debug("Base58 decode successful, secretKey length:", secretKey.length);
            return { keypair: Keypair.fromSecretKey(secretKey) };
        } catch (e) {
            elizaLogger.warn("Error decoding base58 private key:", e);
            try {
                // Then try base64
                elizaLogger.info("Trying base64 decode instead");
                const secretKey = Uint8Array.from(
                    Buffer.from(privateKeyString, "base64")
                );
                elizaLogger.debug("Base64 decode successful, secretKey length:", secretKey.length);
                return { keypair: Keypair.fromSecretKey(secretKey) };
            } catch (e2) {
                elizaLogger.warn("Error decoding base64 private key:", e2);
                try {
                    // Try direct buffer conversion for raw secret key
                    elizaLogger.info("Trying direct buffer conversion");
                    const rawBuffer = Buffer.from(privateKeyString);
                    elizaLogger.debug("Raw buffer conversion, buffer length:", rawBuffer.length);
                    if (rawBuffer.length === 64) {
                        return { keypair: Keypair.fromSecretKey(rawBuffer) };
                    }
                    // Try extracting 64 bytes from the raw string if it's longer
                    elizaLogger.debug("Attempting to extract 64 bytes from buffer");
                    const extracted = Buffer.alloc(64);
                    rawBuffer.copy(extracted, 0, 0, Math.min(64, rawBuffer.length));
                    return { keypair: Keypair.fromSecretKey(extracted) };
                } catch (e3) {
                    elizaLogger.error("Error with direct buffer conversion:", e3);
                    throw new Error("Invalid private key format");
                }
            }
        }
    } else {
        // Try runtime settings first
        let publicKeyString =
            runtime.getSetting("SOLANA_PUBLIC_KEY") ??
            runtime.getSetting("WALLET_PUBLIC_KEY");

        // If not found in runtime settings, try environment variables directly
        if (!publicKeyString) {
            publicKeyString = process.env.SOLANA_PUBLIC_KEY ?? process.env.WALLET_PUBLIC_KEY ?? null;
            elizaLogger.info("Using public key from environment variables");
        }

        if (!publicKeyString) {
            throw new Error("Public key not found in settings or environment variables");
        }

        return { publicKey: new PublicKey(publicKeyString) };
    }
}
