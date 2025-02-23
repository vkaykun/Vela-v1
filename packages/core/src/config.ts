import { config } from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from root .env file
config({ path: path.resolve(__dirname, "../../../.env") });
