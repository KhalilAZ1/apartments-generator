/**
 * Google Drive: create folder per listing, upload images, make shareable.
 * Supports either service account (credentials JSON path) or OAuth (client ID + secret + refresh token).
 */

import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { getConfig } from "../config/env";

export interface DriveUploadResult {
  fileId: string;
  webViewLink: string;
}

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

/**
 * Create Drive client. Uses OAuth (client ID + secret + refresh token) if set, otherwise service account from file.
 * Throws with a clear message if config or file is invalid.
 */
async function getDriveClient(): Promise<{
  drive: ReturnType<typeof google.drive>;
  config: ReturnType<typeof getConfig>;
}> {
  const config = getConfig();

  if (config.GOOGLE_DRIVE_CLIENT_ID && config.GOOGLE_DRIVE_CLIENT_SECRET && config.GOOGLE_DRIVE_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      config.GOOGLE_DRIVE_CLIENT_ID,
      config.GOOGLE_DRIVE_CLIENT_SECRET,
      "urn:ietf:wg:oauth:2.0:oob"
    );
    oauth2Client.setCredentials({
      refresh_token: config.GOOGLE_DRIVE_REFRESH_TOKEN,
    });
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    return { drive, config };
  }

  const keyPath = path.resolve(config.GOOGLE_DRIVE_CREDENTIALS_PATH);
  let keyFile: unknown;
  try {
    const raw = fs.readFileSync(keyPath, "utf-8");
    keyFile = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("no such file")) {
      throw new Error(
        `GOOGLE_DRIVE_CREDENTIALS_PATH: file not found at "${keyPath}". ` +
          `Check that the path in .env is correct and the file exists.`
      );
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        `GOOGLE_DRIVE_CREDENTIALS_PATH: invalid JSON in "${keyPath}". ` +
          `The file should be a valid Google service account JSON key.`
      );
    }
    throw new Error(
      `GOOGLE_DRIVE_CREDENTIALS_PATH: error reading "${keyPath}". ${msg}`
    );
  }
  if (!keyFile || typeof keyFile !== "object") {
    throw new Error(
      `GOOGLE_DRIVE_CREDENTIALS_PATH: file at "${keyPath}" did not parse to a valid credentials object.`
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: keyFile as Record<string, unknown>,
    scopes: SCOPES,
  });

  const drive = google.drive({ version: "v3", auth });
  return { drive, config };
}

/**
 * Create a folder under the root. Name: YYYY-MM-DD_HH-mm-ss_<listingId>
 */
export async function createListingFolder(
  listingId: string,
  logs: string[] = []
): Promise<{ folderId: string; folderUrl: string } | null> {
  const addLog = (msg: string) => logs.push(`[Drive] ${msg}`);

  try {
    const { drive, config } = await getDriveClient();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(":", "-");
    const name = `${dateStr}_${timeStr}_${listingId}`;

    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [config.GOOGLE_DRIVE_ROOT_FOLDER_ID],
      },
      fields: "id, webViewLink",
    });

    const folderId = res.data.id;
    if (!folderId) {
      addLog("Create folder returned no id");
      return null;
    }

    try {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: "reader", type: "anyone" },
      });
    } catch (permErr) {
      const msg = permErr instanceof Error ? permErr.message : String(permErr);
      addLog(`Folder created but "anyone" share failed (file still usable): ${msg}`);
    }

    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
    addLog(`Created folder ${name} -> ${folderUrl}`);
    return { folderId, folderUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(`Create folder error: ${message}`);
    return null;
  }
}

/**
 * Upload a buffer as image to the given folder. Filename: 01.jpg, 02.jpg, ...
 */
export async function uploadImageToDrive(
  folderId: string,
  imageBuffer: Buffer,
  index: number,
  logs: string[] = []
): Promise<DriveUploadResult | null> {
  const addLog = (msg: string) => logs.push(`[Drive] ${msg}`);

  try {
    const { drive } = await getDriveClient();
    const filename = `${String(index).padStart(2, "0")}.jpg`;

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
      },
      media: {
        mimeType: "image/jpeg",
        body: Readable.from(imageBuffer),
      },
      fields: "id, webViewLink",
    });

    const fileId = res.data.id;
    const webViewLink = res.data.webViewLink;
    if (!fileId) {
      addLog(`Upload ${filename} returned no id`);
      return null;
    }

    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
      });
    } catch (permErr) {
      const msg = permErr instanceof Error ? permErr.message : String(permErr);
      addLog(`Uploaded ${filename} but "anyone" share failed (file still in folder): ${msg}`);
    }

    addLog(`Uploaded ${filename} -> ${webViewLink ?? fileId}`);
    return {
      fileId,
      webViewLink: webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(`Upload error: ${message}`);
    return null;
  }
}

/**
 * Upload a plain text file to the given folder. Used for listing info (rooms, size, city, rent).
 */
export async function uploadTextFileToDrive(
  folderId: string,
  filename: string,
  content: string,
  logs: string[] = []
): Promise<DriveUploadResult | null> {
  const addLog = (msg: string) => logs.push(`[Drive] ${msg}`);

  try {
    const { drive } = await getDriveClient();
    const buffer = Buffer.from(content, "utf-8");

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
        mimeType: "text/plain",
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from(buffer),
      },
      fields: "id, webViewLink",
    });

    const fileId = res.data.id;
    const webViewLink = res.data.webViewLink;
    if (!fileId) {
      addLog(`Upload ${filename} returned no id`);
      return null;
    }

    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
      });
    } catch (permErr) {
      const msg = permErr instanceof Error ? permErr.message : String(permErr);
      addLog(`Uploaded ${filename} but "anyone" share failed (file still in folder): ${msg}`);
    }

    addLog(`Uploaded ${filename} -> ${webViewLink ?? fileId}`);
    return {
      fileId,
      webViewLink: webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(`Upload text file error: ${message}`);
    return null;
  }
}
