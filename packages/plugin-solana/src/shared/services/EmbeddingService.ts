// packages/plugin-solana/src/shared/services/EmbeddingService.ts

import { IAgentRuntime, elizaLogger, Service, ServiceType } from "@elizaos/core";

export interface EmbeddingConfig {
    enabled: boolean;
    dimension: number;
    modelName?: string;
    batchSize?: number;
    cacheResults?: boolean;
}

export class EmbeddingService {
    private static instance: EmbeddingService;
    private textGenService?: Service & { getEmbeddingResponse(text: string): Promise<number[]> };
    private config: EmbeddingConfig;

    private constructor(
        private runtime: IAgentRuntime,
        config: Partial<EmbeddingConfig>
    ) {
        this.config = {
            enabled: process.env.USE_EMBEDDINGS === "true",
            dimension: parseInt(process.env.EMBEDDING_DIMENSION || "1536"),
            modelName: process.env.EMBEDDING_MODEL,
            batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || "10"),
            cacheResults: process.env.CACHE_EMBEDDINGS === "true",
            ...config
        };

        if (this.config.enabled) {
            this.initializeService();
        }
    }

    public static getInstance(runtime: IAgentRuntime, config?: Partial<EmbeddingConfig>): EmbeddingService {
        if (!this.instance) {
            this.instance = new EmbeddingService(runtime, config || {});
        }
        return this.instance;
    }

    private initializeService(): void {
        try {
            this.textGenService = this.runtime.getService(ServiceType.TEXT_GENERATION) as Service & {
                getEmbeddingResponse(text: string): Promise<number[]>;
            };

            if (!this.textGenService) {
                elizaLogger.warn("Text generation service not available. Embeddings will be disabled.");
                this.config.enabled = false;
            }
        } catch (error) {
            elizaLogger.error("Failed to initialize embedding service:", error);
            this.config.enabled = false;
        }
    }

    public isEnabled(): boolean {
        return this.config.enabled && !!this.textGenService;
    }

    public getDimension(): number {
        return this.config.dimension;
    }

    public async getEmbedding(text: string): Promise<number[] | null> {
        if (!this.isEnabled() || !text) {
            return null;
        }

        try {
            return await this.textGenService!.getEmbeddingResponse(text);
        } catch (error) {
            elizaLogger.error("Error generating embedding:", error);
            return null;
        }
    }

    public async getEmbeddingsBatch(texts: string[]): Promise<(number[] | null)[]> {
        if (!this.isEnabled() || texts.length === 0) {
            return texts.map(() => null);
        }

        const batchSize = this.config.batchSize || 10;
        const results: (number[] | null)[] = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(text => this.getEmbedding(text))
            );
            results.push(...batchResults);
        }

        return results;
    }

    public calculateSimilarity(embedding1: number[], embedding2: number[]): number {
        if (embedding1.length !== embedding2.length) {
            throw new Error("Embeddings must have the same dimension");
        }

        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;

        for (let i = 0; i < embedding1.length; i++) {
            dotProduct += embedding1[i] * embedding2[i];
            norm1 += embedding1[i] * embedding1[i];
            norm2 += embedding2[i] * embedding2[i];
        }

        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }
} 