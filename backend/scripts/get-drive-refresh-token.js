/**
 * One-time script to get a Google Drive OAuth refresh token.
 * Run from project root: node backend/scripts/get-drive-refresh-token.js
 * Requires GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET in .env.
 *
 * IMPORTANT: In Google Cloud Console → Credentials → your OAuth 2.0 Client ID
 * → "Authorized redirect URIs" add exactly:  http://localhost:3456
 * (no trailing slash). Then run this script again.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });
require("dotenv").config({ path: path.resolve(process.cwd(), "..", ".env") });

const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_DRIVE_CLIENT_ID or GOOGLE_DRIVE_CLIENT_SECRET in .env");
  process.exit(1);
}

const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const http = require("http");
const { google } = require("googleapis");

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "", REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<p>Authorization failed: ${error}. Check the terminal for instructions.</p><p>You can close this tab.</p>`
    );
    return;
  }

  if (!code) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<p>No code received. Check the terminal and try again.</p><p>You can close this tab.</p>");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<p>No refresh_token. Revoke app access at <a href='https://myaccount.google.com/permissions'>myaccount.google.com/permissions</a> and run the script again.</p><p>You can close this tab.</p>"
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<p><strong>Success.</strong> Copy the refresh token from the terminal and add it to your .env as GOOGLE_DRIVE_REFRESH_TOKEN=...</p><p>You can close this tab.</p>"
    );
    console.log("\nAdd this to your .env file:\n");
    console.log("GOOGLE_DRIVE_REFRESH_TOKEN=" + tokens.refresh_token);
  } catch (err) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<p>Error: " + (err.message || err) + "</p><p>You can close this tab.</p>");
    console.error("Error exchanging code:", err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(REDIRECT_PORT, () => {
  const scopes = ["https://www.googleapis.com/auth/drive.file"];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });
  console.log("1. Add this redirect URI in Google Cloud Console if you haven't yet:");
  console.log("   Credentials → your OAuth 2.0 Client ID → Authorized redirect URIs");
  console.log("   Add: " + REDIRECT_URI + "\n");
  console.log("2. Open this URL in your browser and sign in with the Google account that owns the Drive folder:\n");
  console.log(authUrl);
  console.log("\n3. After you allow access, this script will receive the code and print the refresh token.");
});
