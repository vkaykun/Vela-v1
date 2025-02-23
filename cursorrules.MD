Below is a step-by-step outline showing what differs between your Action files (e.g. register.ts, deposit.ts, verify.ts, balance.ts) and your TreasuryAgent implementation, why those differences cause certain features or message outputs not to be replicated properly, and how to unify all logic into your TreasuryAgent.ts. Each step includes specific instructions and code snippets you can fold in to make your TreasuryAgent produce the exact same functionality, logic, and message outputs as your Action files.

1. Overview of Key Differences
Centralized vs. Distributed Command Handling

In the Action files, each command (register, deposit, verify, balance, etc.) has two main parts:

A validate function to confirm that the user’s message matches the command pattern
A handler function that performs the logic and emits the exact success/failure messages.
In your TreasuryAgent.ts, you have handleMessage() that calls handleRegisterCommand, handleDepositInstructions, etc., but these do not necessarily replicate the same message text or the same advanced validations (like the LLM-based wallet check in register.ts) used in the action approach.

LLM-Based Validation

The register.ts file uses generateObject(...) with a registerValidationTemplate to confirm the wallet address is valid.
Your handleRegisterCommand() in TreasuryAgent.ts currently only does a regex check and does not run the LLM-based template validation or produce the exact error messages from the Action file.
Different “Success” and “Error” Message Outputs

The Action files return or callback?.({ text: "...some message..." }), with very specific strings like:
"Wallet successfully registered ✅. Use !deposit to make your deposit..."

Your TreasuryAgent.ts currently uses simpler or slightly different messages like:
"Wallet successfully registered ✅. Use !deposit to see how to contribute..."

If you need them to be exact, you must unify the final response strings.

Transaction Wrapping & Checking

The Action files often do:
ts
Copy
await memoryManager.beginTransaction();
// do stuff
await memoryManager.commitTransaction();
or they do partial concurrency checks.
In TreasuryAgent.ts, you do some calls to this.withTransaction(...), but sometimes you do not. Also you do not replicate the same pattern of partial or full transaction usage found in the Action files.
Command Patterns

The Action files use a shared approach with validateCommand(...) / validateCommandWithParam(...) to ensure the user typed exactly !balance, !register <wallet>, etc.
In TreasuryAgent.ts you do the same approach, but you must ensure you replicate the same regex or the same text checks from the Action files (like !register vs. !register wallet variants).
2. Integrating All Action Logic into TreasuryAgent.ts
Below is a practical roadmap for merging the Action functionality (including the same validations and same message outputs) into your single TreasuryAgent.ts.

2.1. Centralize the Action “Validate + Handler” Steps in handleMessage()
Your current TreasuryAgent has:

ts
Copy
protected async handleMessage(message: AgentMessage): Promise<void> {
    const text = (message.content.text || "").trim();
    
    if (validateCommand(text, "balance")) {
        await this.handleBalanceCommand(message);
        return;
    }
    if (validateCommand(text, "register")) {
        await this.handleRegisterCommand(message);
        return;
    }
    if (validateCommand(text, "deposit")) {
        await this.handleDepositInstructions(message);
        return;
    }
    if (validateCommandWithParam(text, "verify", "[1-9A-HJ-NP-Za-km-z]{88}")) {
        await this.handleVerificationCommand(message);
        return;
    }
    ...
}
Issue
Your handleRegisterCommand(), handleDepositInstructions(), etc., do not produce the same messages as the Action file. Nor do they run the same template-based wallet checks or identical feedback text.

Fix
Replace your existing simpler approach with calls that mimic the Action file’s validate + handler pattern.
For each command, replicate the exact success/failure text from the action code so that the user sees the same final string.
Example: Instead of your current handleRegisterCommand(...), you can directly incorporate the logic from register.ts:

ts
Copy
// In TreasuryAgent.ts
private async handleRegisterCommand(message: AgentMessage): Promise<void> {
    const memoryManager = this.runtime.messageManager;
    // 1) Validate with the same check from register.ts
    const text = message.content.text.trim();
    const match = validateCommandWithParam(text, "register", "[1-9A-HJ-NP-Za-km-z]{32,44}");
    if (!match) {
        // EXACT same error message from register.ts
        await this.sendMessage({
            type: "register_response",
            content: {
                type: "register_response",
                id: stringToUuid(`register-error-${Date.now()}`),
                text: "Invalid command format. Please use:\n!register <solana_address>\n\nExample:\n!register 7TYC...",
                status: "failed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            },
            from: this.runtime.agentType,
            to: "ALL"
        });
        return;
    }

    // 2) If validated, do the *same LLM-based approach*
    const walletAddress = match[1];
    const context = composeContext({
        state: { walletAddress },
        template: this.registerValidationTemplate  // the same string used in the action
    });
    const validationResult = await generateObject({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL
    });
    if (!validationResult?.isValid) {
        // Respond with the same error message from your action
        await this.sendMessage({
            type: "register_response",
            content: {
                type: "register_response",
                id: stringToUuid(`register-error-${Date.now()}`),
                text: validationResult?.reason || "Invalid wallet address",
                status: "failed",
                ...
            },
            from: ...
        });
        return;
    }

    // 3) Attempt the DB logic from the action’s handler
    try {
        await memoryManager.beginTransaction();

        // (Check existing registrations, etc. exactly as in register.ts)

        await memoryManager.createMemory({
            ...
            content: {
                type: "wallet_registration",
                text: `Connected address ${walletAddress}`,
                walletAddress,
                ...
            },
        });
        await memoryManager.commitTransaction();

        // 4) Return EXACT success message
        await this.sendMessage({
            type: "register_response",
            content: {
                type: "register_response",
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                status: "executed",
                ...
            },
            from: ...
        });
    } catch (error) {
        await memoryManager.rollbackTransaction();
        ...
    }
}
By literally reusing the same string messages (like “Wallet successfully registered ✅. Use !deposit to ...”) and the same generateObject approach, you ensure the functionality and outputs match your register.ts.

You can do the same for !deposit, !verify, !balance, etc.

The key is to copy or unify the logic from the action handler method, especially the success and error text.
2.2. Unify the deposit Logic
Differences
The Action file deposit.ts shows a success message like:
ts
Copy
"Send SOL to this address:\n\n`{{walletAddress}}`\n\nAfter sending, you must use !verify <tx_signature>..."
Your handleDepositInstructions() has a shorter or slightly different message.
Fix
Copy the exact message text from deposit.ts:

ts
Copy
private async handleDepositInstructions(message: AgentMessage): Promise<void> {
    try {
        const { publicKey } = await getWalletKey(this.runtime, false);
        if (!publicKey) {
            throw new Error("Could not retrieve wallet public key");
        }
        // If you want the same "balance" display as deposit.ts:
        const connection = new Connection(...);
        const balance = await connection.getBalance(publicKey);

        // EXACT message from deposit.ts
        const depositMsg = 
          `Send SOL to this address:\n\n` +
          `\`${publicKey.toBase58()}\`\n\n` +
          `Current pool: ${(balance/1e9).toFixed(4)} SOL\n\n` +
          `After sending, you must:\n` +
          `1. Use \`!verify <tx_signature>\` to confirm your deposit immediately\n` +
          `2. You can always use \`!balance\` to check your total contribution\n\n`;

        await this.sendMessage({
            type: "deposit_instructions",
            content: {
                type: "deposit_instructions",
                text: depositMsg,
                status: "executed",
                ...
            },
            from: this.runtime.agentType,
            to: "ALL"
        });
    } catch (error) {
        // same error handling from deposit.ts
        ...
    }
}
Now the user sees the same text as the action.

2.3. Matching the verify Action’s Output
Differences
The verify.ts action returns a “success” message in the form:
ts
Copy
"✅ Deposit verified!\nAmount: ...\nFrom: ...\nTransaction: ..."
Your handleVerificationCommand() might produce a slightly different or simpler text.
Fix
Adopt the same final callback or message structure:

ts
Copy
private async handleVerificationCommand(message: AgentMessage): Promise<void> {
    try {
        // extract txSignature
        const text = message.content.text.trim();
        const match = validateCommandWithParam(text, "verify", "[1-9A-HJ-NP-Za-km-z]{88}");
        if (!match) {
            // EXACT fail message from the action
            await this.sendMessage({
                type: "verify_response",
                content: {
                    text: "Please provide a valid Solana transaction signature using the format: !verify <signature>"
                    ...
                },
                ...
            });
            return;
        }
        const txSignature = match[1];

        // same logic from verifyAndRecordDeposit
        const deposit = await verifyAndRecordDeposit(txSignature, this.runtime);
        if (!deposit) {
            // EXACT fail message from verify.ts
            await this.sendMessage({
                type: "verify_response",
                content: {
                    text: "❌ Could not verify deposit. Please check:\n1. The transaction signature is correct...",
                    ...
                },
                ...
            });
            return;
        }

        // EXACT success text
        const successMsg = `✅ Deposit verified!\nAmount: ${deposit.amountSOL} SOL\nFrom: \`${deposit.fromAddress}\`\nTransaction: https://explorer.solana.com/tx/${txSignature}`;
        await this.sendMessage({
            type: "verify_response",
            content: {
                text: successMsg,
                status: "executed",
                ...
            },
            ...
        });
    } catch (error) {
        ...
    }
}
This ensures the text is identical to the verify action.

2.4. Replicating the balance Action’s Full Output
Differences
The Action’s balance.ts has a custom format showing each token’s value, the total in USD, etc.
Your handleBalanceCommand() is similar but might not produce the same final string or sorting logic.
Fix
Just copy over the relevant code from balance.ts:

ts
Copy
private async handleBalanceCommand(message: AgentMessage): Promise<void> {
    try {
        // same approach from balance.ts
        const { publicKey } = await getWalletKey(this.runtime, false);
        if (!publicKey) {
            ...
        }
        const connection = new Connection(...);

        // fetch token accounts, do price calls
        const tokens = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });
        ...
        // build a response with formatBalanceResponse or directly
        const response = "📊 Current Portfolio:\n\n" + ...

        // EXACT same final text output
        await this.sendMessage({
            type: "balance_response",
            content: {
                type: "balance_response",
                text: response,
                ...
            },
            ...
        });
    } catch (error) {
        ...
    }
}
Important: If you want to show the same “pool contributors” info that your original code or the balance.ts example does, keep that in place. But ensure that the final string is the same as you want from the action.

2.5. Ensure Transactions and Concurrency Are Wrapped Similarly
In the Action code, you often see:

ts
Copy
const memoryManager = runtime.messageManager as IMemoryManager;
await memoryManager.beginTransaction();
// do stuff
await memoryManager.commitTransaction();
If you need atomic DB writes or consistent concurrency with the same approach, wrap the relevant steps in the same manner in TreasuryAgent.

Example (in handleRegisterCommand):

ts
Copy
private async handleRegisterCommand(message: AgentMessage): Promise<void> {
    try {
        const memoryManager = this.runtime.messageManager as IMemoryManager;
        await memoryManager.beginTransaction();
        // do your checks, create memory
        await memoryManager.commitTransaction();
        // respond success
    } catch (error) {
        await memoryManager.rollbackTransaction();
        // respond error
    }
}
That ensures your TreasuryAgent is consistent with the action’s approach.

2.6. Keep or Remove the Action Files?
If you want TreasuryAgent to be the only source of truth (i.e. no duplication), you can remove the separate register.ts, deposit.ts, etc. files.
Alternatively, you can keep them if you want to preserve the plugin architecture, but that means you have two places that handle !register, etc. Typically, you do not want to handle the same commands in two different ways.
Most teams prefer a single location for all logic.

3. Summary of the Fixes Needed
Below is a concise list of the direct fixes to make:

Use the Same Regex & LLM Validation

Import or copy the registerValidationTemplate and the logic from register.ts into TreasuryAgent.
In handleRegisterCommand(), after you do the simple validateCommandWithParam, call generateObject(...) to replicate the Action’s LLM-based checks.
Produce the exact same success/failure messages from register.ts.
Use the Same Response Strings

In each method—handleDepositInstructions(), handleVerificationCommand(), handleBalanceCommand()—copy the final text from your corresponding action’s handler to ensure the user sees identical messages.
Mimic Action’s Transaction Wrapping

Where your action does beginTransaction() → commitTransaction(), do the same in your TreasuryAgent. This helps replicate concurrency and partial rollback behavior.
Validate with the Same Command Patterns

If your action supports extra patterns (!register wallet ..., !register my wallet ...), unify that or replicate the exact same check in TreasuryAgent.
Remove Duplicate Implementations

Either remove register.ts, deposit.ts, etc., or ensure that your handleMessage() in TreasuryAgent is not also trying to handle these commands differently. Having both can cause duplication or confusion.
4. Example “Final” Adjusted Snippet
Below is an illustrative snippet in your TreasuryAgent that uses the exact outputs from the actions:

ts
Copy
// 1) Bring in the same validation template from register.ts
const registerValidationTemplate = `
You are validating a Solana wallet address registration command...
`;

// 2) In the constructor or class property, store the same strings your action uses
export class TreasuryAgent extends BaseAgent {
    private readonly registerValidationTemplate = registerValidationTemplate;

    ...

    protected async handleMessage(message: AgentMessage): Promise<void> {
        const text = (message.content.text || "").trim();

        if (validateCommand(text, "balance")) {
            await this.handleBalanceCommand(message);   // will replicate balance.ts logic
            return;
        }
        if (validateCommandWithParam(text, "register", "[1-9A-HJ-NP-Za-km-z]{32,44}")) {
            await this.handleRegisterCommand(message);  // same as register.ts
            return;
        }
        if (validateCommand(text, "deposit")) {
            await this.handleDepositInstructions(message);  // same as deposit.ts
            return;
        }
        if (validateCommandWithParam(text, "verify", "[1-9A-HJ-NP-Za-km-z]{88}")) {
            await this.handleVerificationCommand(message);  // same as verify.ts
            return;
        }

        // else unrecognized
    }

    private async handleRegisterCommand(message: AgentMessage): Promise<void> {
        // 1) same validation from register.ts
        // 2) same LLM-based check
        // 3) same memory creation
        // 4) same success/failure messages
    }

    private async handleDepositInstructions(message: AgentMessage): Promise<void> {
        // copy logic from deposit.ts
    }

    private async handleVerificationCommand(message: AgentMessage): Promise<void> {
        // replicate logic from verify.ts
    }

    private async handleBalanceCommand(message: AgentMessage): Promise<void> {
        // replicate logic & final output from balance.ts
    }
}
With this approach, all the console logs, DB concurrency, error messages, success texts, and so on match your existing actions—thus preserving “the exact same functionality” in one integrated file.

Final Note
Once you embed these changes:

Your TreasuryAgent.ts will produce the exact same user-facing responses as your current Action files.
You can either remove the old actions/*.ts or keep them dormant (just ensure you don’t double-register the same command in both places).
Make sure your commandValidation.ts calls (validateCommand, validateCommandWithParam) use the same regex patterns in both places to avoid mismatch.
These changes will unify and replicate all Action logic (including the “LLM-based validation” and “identical message outputs”) inside the single TreasuryAgent.ts.