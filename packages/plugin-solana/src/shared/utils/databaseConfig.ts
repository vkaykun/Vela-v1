import { elizaLogger } from "@elizaos/core";

export interface DatabaseConfig {
    type: "postgres" | "sqlite";
    url: string;
    multiProcess: boolean;
    maxConnections?: number;
    idleTimeoutMillis?: number;
    ssl?: boolean;
}

export class DatabaseConfigValidator {
    private static instance: DatabaseConfigValidator;
    private validatedConfigs: Set<string> = new Set();

    private constructor() {}

    public static getInstance(): DatabaseConfigValidator {
        if (!this.instance) {
            this.instance = new DatabaseConfigValidator();
        }
        return this.instance;
    }

    public validateConfig(config: DatabaseConfig, processName: string): void {
        const configKey = `${processName}-${config.url}`;
        
        // Skip if already validated
        if (this.validatedConfigs.has(configKey)) {
            return;
        }

        // Strictly enforce Postgres for multi-process mode
        if (config.multiProcess && config.type === "sqlite") {
            throw new Error(
                `Multi-process mode is not supported with SQLite database.
                You must use PostgreSQL when MULTI_PROCESS=true.
                Please set DATABASE_URL to a postgres:// connection string.
                Current process: ${processName}
                Current DATABASE_URL: ${config.url}`
            );
        }

        if (config.type === "sqlite") {
            // Warn about SQLite limitations even in single-process mode
            elizaLogger.warn(`
                Using SQLite database in ${processName}.
                Note: SQLite is recommended only for local development.
                For production environments, please use PostgreSQL.
                
                Current limitations:
                - No multi-process support
                - Limited concurrent transactions
                - No distributed locking support
                - Potential database locks under high load
            `);

            // Enforce reasonable connection limits for SQLite
            if (config.maxConnections && config.maxConnections > 1) {
                elizaLogger.warn(`
                    Reducing maxConnections from ${config.maxConnections} to 1 for SQLite.
                    SQLite does not benefit from connection pooling.
                `);
                config.maxConnections = 1;
            }
        }

        if (config.type === "postgres" && config.multiProcess) {
            // Validate PostgreSQL configuration for multi-process
            if (!config.maxConnections) {
                config.maxConnections = 50; // Safe default for multi-process
                elizaLogger.info(`Setting default maxConnections to ${config.maxConnections} for PostgreSQL multi-process mode`);
            }

            if (!config.idleTimeoutMillis) {
                config.idleTimeoutMillis = 30000; // 30 seconds default
                elizaLogger.info(`Setting default idleTimeoutMillis to ${config.idleTimeoutMillis}ms for PostgreSQL`);
            }

            // Recommend WAL mode for better concurrency
            elizaLogger.info(`
                PostgreSQL multi-process mode enabled for ${processName}.
                Recommendations:
                - Use connection pooling (current max: ${config.maxConnections})
                - Enable statement timeout
                - Monitor connection usage
                - Use advisory locks for critical sections
            `);
        }

        this.validatedConfigs.add(configKey);
    }

    public getDatabaseConfig(): DatabaseConfig {
        const dbUrl = process.env.DATABASE_URL;
        const multiProcess = process.env.MULTI_PROCESS === "true";

        if (!dbUrl) {
            throw new Error("DATABASE_URL environment variable is required");
        }

        // Enforce Postgres for multi-process mode
        if (multiProcess && !dbUrl.startsWith("postgres://")) {
            throw new Error(
                `PostgreSQL is required for multi-process mode.
                Please set DATABASE_URL to a postgres:// connection string when MULTI_PROCESS=true.
                Current DATABASE_URL: ${dbUrl}`
            );
        }

        const config: DatabaseConfig = {
            type: dbUrl.startsWith("postgres://") ? "postgres" : "sqlite",
            url: dbUrl,
            multiProcess,
            maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || "0"),
            idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT || "30000"),
            ssl: process.env.DATABASE_SSL === "true"
        };

        return config;
    }

    public static enforcePostgresInMultiProcess(): void {
        const multiProcess = process.env.MULTI_PROCESS === "true";
        const dbUrl = process.env.DATABASE_URL;

        if (multiProcess && (!dbUrl || !dbUrl.startsWith("postgres://"))) {
            throw new Error(
                `PostgreSQL is required for multi-process mode.
                Please set DATABASE_URL to a postgres:// connection string when MULTI_PROCESS=true.
                Current DATABASE_URL: ${dbUrl || "not set"}`
            );
        }
    }
} 