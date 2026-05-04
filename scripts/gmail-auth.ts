/**
 * Gmail OAuth2 Authorization Helper
 *
 * Usage:
 *   npx tsx scripts/gmail-auth.ts <CLIENT_ID> <CLIENT_SECRET>
 *
 * 1. Opens a URL in the console — copy and paste into browser
 * 2. Authorize the app in Google
 * 3. Copy the authorization code from the browser
 * 4. Paste it back in the terminal
 * 5. Script outputs the refresh token to use in the app
 */

import { google } from "googleapis";
import * as readline from "readline";

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

async function main() {
  const clientId = process.argv[2];
  const clientSecret = process.argv[3];

  if (!clientId || !clientSecret) {
    console.error("Usage: npx tsx scripts/gmail-auth.ts <CLIENT_ID> <CLIENT_SECRET>");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("\n=== Gmail OAuth2 Authorization ===\n");
  console.log("1. Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\n2. Authorize the application");
  console.log("3. Copy the authorization code and paste it below:\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question("Authorization code: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  try {
    const { tokens } = await oauth2.getToken(code);

    console.log("\n=== Tokens ===\n");
    console.log("Refresh Token:", tokens.refresh_token);
    console.log("Access Token:", tokens.access_token);
    console.log("Expires At:", tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : "N/A");
    console.log("\nUse the refresh token when configuring the email inbox in the app.");
  } catch (err) {
    console.error("\nFailed to exchange code for tokens:", err);
    process.exit(1);
  }
}

main();
